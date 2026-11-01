/*
  What a product's Worker calls, through a Service Binding (no secret, no HTTP):

    "services": [{ "binding": "ANALYTICS", "service": "saas-analytics", "entrypoint": "AnalyticsService",
                   "props": { "product": "acme" } }]

  The product is fixed by the binding's `props`, so a product can only write as itself.
  Every method is safe to fire and forget inside `ctx.waitUntil`: none throws to the caller.
*/
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { cleanProps, eventName } from "./events";
import { ANON_COOKIE, dayHash, readCookie, signUser, utcDay, validAnon } from "./identity";
import { productById, type Product } from "./products";
import { killed } from "./collect";

/** The request of the signed-in user, as the product saw it. All optional. */
export type Seen = { ip?: string | null; ua?: string | null; cookie?: string | null };

export type TrackInput = {
  event: string;
  userId?: string | null;
  workspaceId?: string | null;
  props?: Record<string, unknown>;
  ts?: number;
  /** For the cookie and day hash of the browser the action came from, when there is one. */
  seen?: Seen;
};

export type IdentifyInput = {
  userId: string;
  email?: string | null;
  name?: string | null;
  workspaceId?: string | null;
  plan?: string | null;
  traits?: Record<string, unknown>;
  createdAt?: string | null;
  /** true on account creation: attribute the signup to the visit it came from. */
  signup?: boolean;
  attributeSignup?: boolean;
  seen?: Seen;
  /** Attribution the product knows itself (e.g. utm kept through its own signup form). */
  utm?: { source?: string; medium?: string; campaign?: string } | null;
};

type Props = { product?: string };

export class AnalyticsService extends WorkerEntrypoint<Env, Props> {
  private product(explicit?: string): Product | null {
    const id = this.ctx.props?.product ?? explicit;
    return id ? productById(this.env.PRODUCTS, id) : null;
  }

  /** A server-side product event. */
  async track(input: TrackInput, product?: string): Promise<boolean> {
    try {
      const p = this.product(product);
      if (!p || (await killed(this.env, p.id))) return false;
      return await serverTrack(this.env, p, input);
    } catch (e) { log("rpc_track_failed", e); return false; }
  }

  /** Create or update the person; on `signup`, attribute it. Returns the attribution method. */
  async identify(input: IdentifyInput, product?: string): Promise<{ method: string } | null> {
    try {
      const p = this.product(product);
      if (!p || !input?.userId) return null;
      return await identify(this.env, p, input);
    } catch (e) { log("rpc_identify_failed", e); return null; }
  }

  /** A token the product puts in its signed-in pages: the tracker sends it, the collector trusts it. */
  async userToken(userId: string, workspaceId?: string | null, product?: string): Promise<string | null> {
    try {
      const p = this.product(product);
      return p && userId ? await signUser(this.env, p.id, String(userId), workspaceId ?? null) : null;
    } catch (e) { log("rpc_user_token_failed", e); return null; }
  }

  /** Account deleted: profile, identities, payments link and replays go. Raw files keep only the opaque id. */
  async forget(userId: string, product?: string): Promise<boolean> {
    try {
      const p = this.product(product);
      if (!p) return false;
      await forget(this.env, p.id, userId);
      return true;
    } catch (e) { log("rpc_forget_failed", e); return false; }
  }
}

const log = (event: string, e: unknown) => console.error(JSON.stringify({ event, reason: String((e as Error)?.message ?? e).slice(0, 200) }));

export async function serverTrack(env: Env, p: Product, input: TrackInput): Promise<boolean> {
  const name = eventName(input.event);
  if (!name || name.startsWith("$")) return false;
  const now = Date.now();
  const anon = validAnon(readCookie(input.seen?.cookie ?? null, ANON_COOKIE));
  const hash = input.seen?.ip ? await dayHash(env, p.id, input.seen.ip, input.seen.ua ?? "", now) : null;
  await env.STREAM.send([{
    ts: typeof input.ts === "number" ? Math.round(input.ts) : now, received_at: now, schema: 1,
    product: p.id, host: "", surface: "server", event: name, origin: "server",
    level: input.userId ? 2 : anon ? 1 : 0,
    day_hash: hash, anon_id: anon, user_id: input.userId ? String(input.userId) : null, workspace_id: input.workspaceId ?? null,
    props: cleanProps(input.props),
  }]);
  if (input.userId) {
    /* At most one write an hour per person; the first workspace seen sticks (Stripe attribution). */
    await env.DB.prepare(`UPDATE people SET last_seen_at = ?1, updated_at = ?1, workspace_id = COALESCE(workspace_id, ?4)
        WHERE product = ?2 AND user_id = ?3 AND (last_seen_at IS NULL OR last_seen_at < ?5 OR (workspace_id IS NULL AND ?4 IS NOT NULL))`)
      .bind(new Date(now).toISOString(), p.id, String(input.userId), input.workspaceId ?? null, new Date(now - 3600_000).toISOString()).run();
  }
  return true;
}

type Touch = Record<string, string>;

/** The first landing of this browser in the last 3 days, by cookie first, then by day hash. */
export async function findTouch(env: Env, p: Product, seen: Seen | undefined): Promise<{ touch: Touch | null; method: string; idents: [string, string][] }> {
  const idents: [string, string][] = [];
  const anon = validAnon(readCookie(seen?.cookie ?? null, ANON_COOKIE));
  if (anon) {
    idents.push(["anon", anon]);
    const first = await env.DB.prepare("SELECT first_touch FROM anon_first WHERE product = ? AND anon_id = ?").bind(p.id, anon).first<{ first_touch: string }>();
    if (first) return { touch: JSON.parse(first.first_touch), method: "cookie", idents };
    const v = await env.DB.prepare("SELECT touch FROM recent_visits WHERE product = ? AND ident = ?").bind(p.id, `a:${anon}`).first<{ touch: string }>();
    if (v) return { touch: JSON.parse(v.touch), method: "cookie", idents };
  }
  if (seen?.ip) {
    const now = Date.now();
    const today = await dayHash(env, p.id, seen.ip, seen.ua ?? "", now, false);
    const yesterday = await dayHash(env, p.id, seen.ip, seen.ua ?? "", now - 86400_000, false);
    for (const h of [yesterday, today]) {
      if (!h) continue;
      idents.push(["hash", h]);
      const v = await env.DB.prepare("SELECT touch FROM recent_visits WHERE product = ? AND ident = ?").bind(p.id, `h:${h}`).first<{ touch: string }>();
      if (v) return { touch: JSON.parse(v.touch), method: "hash", idents };
    }
  }
  return { touch: null, method: "none", idents };
}

export async function identify(env: Env, p: Product, input: IdentifyInput): Promise<{ method: string }> {
  const now = new Date().toISOString();
  const userId = String(input.userId);
  let firstTouch: string | null = null;
  let method: string | null = null;
  const createdAt = input.createdAt ? Date.parse(input.createdAt) : NaN;
  const age = Date.now() - createdAt;
  const attributeSignup = input.attributeSignup === true && Number.isFinite(age) && age >= -5000 && age <= 15 * 60_000;
  if (input.signup || attributeSignup) {
    const found = await findTouch(env, p, input.seen);
    let touch = found.touch;
    if (attributeSignup && !input.signup && touch) {
      const touchAt = Date.parse(touch.at ?? "");
      if (!Number.isFinite(touchAt) || touchAt > createdAt + 5000) touch = null;
    }
    method = touch ? found.method : "none";
    if (!touch && input.utm?.source) {
      touch = { channel: "Campaign", utm_source: input.utm.source, utm_medium: input.utm.medium ?? "", utm_campaign: input.utm.campaign ?? "", at: now };
      method = "utm_on_signup";
    }
    firstTouch = touch ? JSON.stringify(touch) : null;
    const stmts = (input.signup || touch ? found.idents : []).map(([kind, value]) =>
      env.DB.prepare("INSERT OR IGNORE INTO identities (product, kind, value, user_id, method, at) VALUES (?, ?, ?, ?, ?, ?)").bind(p.id, kind, value, userId, found.method, now));
    if (stmts.length) await env.DB.batch(stmts);
  }
  const traits = input.traits ? cleanProps(input.traits) ?? "{}" : null;
  await env.DB.prepare(`INSERT INTO people (product, user_id, email, name, workspace_id, plan, traits, created_at, first_seen_at, last_seen_at, first_touch, attribution_method, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, '{}'), ?8, ?9, ?9, ?10, ?11, ?9)
      ON CONFLICT (product, user_id) DO UPDATE SET
        email = COALESCE(?3, email), name = COALESCE(?4, name), workspace_id = COALESCE(?5, workspace_id), plan = COALESCE(?6, plan),
        traits = COALESCE(?7, traits), last_seen_at = ?9, updated_at = ?9,
        attribution_method = CASE WHEN first_touch IS NULL AND ?10 IS NOT NULL THEN ?11 ELSE COALESCE(attribution_method, ?11) END,
        first_touch = COALESCE(first_touch, ?10)`)
    .bind(p.id, userId, input.email ?? null, input.name ?? null, input.workspaceId ?? null, input.plan ?? null, traits, input.createdAt ?? now, now, firstTouch, method)
    .run();
  /* The sign-up is counted once per person, by whoever reports the account first (signup action, OAuth
     return, auth webhook): a caller that only reports a login no longer loses it. */
  if (input.signup || attributeSignup) await countSignup(env, p, userId, input.workspaceId, input.seen);
  return { method: method ?? "existing" };
}

/** Claims the person's sign-up (atomic) and emits `signup_completed` if nobody did yet. */
export async function countSignup(env: Env, p: Product, userId: string, workspaceId?: string | null, seen?: Seen, ts?: number): Promise<boolean> {
  const claimed = await env.DB.prepare("UPDATE people SET signed_up_at = ?3 WHERE product = ?1 AND user_id = ?2 AND signed_up_at IS NULL RETURNING first_touch, attribution_method")
    .bind(p.id, userId, new Date().toISOString()).first<{ first_touch: string | null; attribution_method: string | null }>();
  if (!claimed) return false;
  const touch = claimed.first_touch ? JSON.parse(claimed.first_touch) : null;
  await serverTrack(env, p, { event: "signup_completed", userId, workspaceId, seen, ts,
    props: { attribution: claimed.attribution_method ?? "none", channel: touch?.channel ?? "", ai_source: touch?.ai_source ?? "" } });
  return true;
}

/** Safety net, hourly: accounts older than 30 min that no caller counted (a webhook that never came). */
export async function reconcileSignups(env: Env, products: Product[]): Promise<number> {
  let n = 0;
  const from = new Date(Date.now() - 10 * 86400_000).toISOString();
  const to = new Date(Date.now() - 30 * 60_000).toISOString();
  for (const p of products) {
    const rows = await env.DB.prepare("SELECT user_id, workspace_id, created_at FROM people WHERE product = ? AND signed_up_at IS NULL AND created_at BETWEEN ? AND ? LIMIT 200")
      .bind(p.id, from, to).all<{ user_id: string; workspace_id: string | null; created_at: string }>();
    for (const r of rows.results ?? []) n += Number(await countSignup(env, p, r.user_id, r.workspace_id, undefined, Date.parse(r.created_at) || undefined));
  }
  return n;
}

export async function forget(env: Env, product: string, userId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM people WHERE product = ? AND user_id = ?").bind(product, userId),
    env.DB.prepare("DELETE FROM identities WHERE product = ? AND user_id = ?").bind(product, userId),
    env.DB.prepare("UPDATE payments SET email = NULL WHERE product = ? AND user_id = ?").bind(product, userId),
  ]);
  const sessions = await env.DB.prepare("SELECT id, day FROM replay_sessions WHERE product = ? AND user_id = ?").bind(product, userId).all<{ id: string; day: string }>();
  for (const s of sessions.results ?? []) {
    const listed = await env.BUCKET.list({ prefix: `replays/${product}/${s.day}/${s.id}/` });
    if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
    await env.DB.prepare("DELETE FROM replay_chunks WHERE session_id = ?").bind(s.id).run();
  }
  await env.DB.prepare("DELETE FROM replay_sessions WHERE product = ? AND user_id = ?").bind(product, userId).run();
  console.log(JSON.stringify({ event: "person_forgotten", product, day: utcDay(Date.now()) }));
}
