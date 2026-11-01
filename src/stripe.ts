/*
  Stripe, read only. Two inputs per product, both optional:
   - STRIPE_WEBHOOK_SECRET_<PRODUCT>: POST /stripe/<product>, events checkout.session.completed,
     invoice.paid, charge.refunded. Signature checked, deduped by event id.
   - STRIPE_KEY_<PRODUCT>: a restricted key with Read on Customers, Charges, Checkout Sessions,
     Invoices, Subscriptions. Backfills the whole history once, then reconciles 3 days nightly.

  Counting rule (no double count): an invoice counts when paid (subscriptions, including their
  first payment); a Checkout Session counts only in `payment` mode (one-off, Payment Links), and
  only above zero. A one-off Checkout with invoice creation also emits an invoice for the same
  purchase: the Checkout wins (it carries the product metadata), its invoice is never counted
  (`session.invoice` removes it if it came first; an invoice with no subscription is skipped when a
  matching Checkout is already there). A refund is the charge's cumulative refunded amount, negative, keyed by charge.
  Who paid: metadata.user_id (Checkout `metadata` and `subscription_data.metadata`), then
  client_reference_id, then the Stripe customer already linked, then the email, then
  metadata.workspace_id (the workspace's first member, for products where a workspace pays).
*/
import type { Env } from "./env";
import { timingSafeEqual } from "./crypto";
import { hmacHex } from "./crypto-extra";
import { rateLimitIpKey, readBoundedText } from "./http-security";
import { productById, products } from "./products";

type Obj = Record<string, any>;
const keyName = (product: string) => product.toUpperCase().replace(/[^A-Z0-9]/g, "_");

export async function handleStripeWebhook(req: Request, env: Env, product: string): Promise<Response> {
  const p = productById(env.PRODUCTS, product);
  const secret = p ? env[`STRIPE_WEBHOOK_SECRET_${keyName(product)}`] : undefined;
  if (!p || !secret) return new Response("unknown product", { status: 404 });
  if (env.PER_IP) {
    const rl = await env.PER_IP.limit({ key: `stripe:${rateLimitIpKey(req.headers.get("cf-connecting-ip"))}` });
    if (!rl.success) return new Response("rate limited", { status: 429 });
  }
  const payload = await readBoundedText(req, 512 * 1024);
  if (payload === null) return new Response("too large", { status: 413 });
  const header = req.headers.get("stripe-signature") ?? "";
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]).filter((x) => x.length === 2));
  const t = Number(parts.t);
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return new Response("stale", { status: 400 });
  const expected = await hmacHex(secret, `${t}.${payload}`);
  if (!sigs.some((s) => timingSafeEqual(s, expected))) return new Response("bad signature", { status: 400 });
  let event: Obj;
  try { event = JSON.parse(payload) as Obj; } catch { return new Response("bad json", { status: 400 }); }
  if (typeof event?.id !== "string") return new Response("bad event", { status: 400 });
  const fresh = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)").bind(event.id, new Date().toISOString()).run();
  if (fresh.meta.changes === 0) return new Response("dup", { status: 200 });
  await ingest(env, product, event.type, event.data?.object ?? {}, Boolean(event.livemode));
  return new Response("ok", { status: 200 });
}

/** What was bought, from the product's own Checkout metadata (plan and interval, or a credit pack). */
function itemOf(m: Obj | undefined): string | null {
  if (!m) return null;
  if (m.plan) return [m.plan, m.interval].filter(Boolean).join(" ");
  if (m.pack_id) return m.pack_id === "custom_credits" ? "credits" : String(m.pack_id);
  return null;
}

export async function ingest(env: Env, product: string, type: string, o: Obj, livemode: boolean) {
  let rec: { id: string; kind: string; amount: number; currency: string; customer: string | null; userId: string | null; email: string | null; created: number; item?: string | null } | null = null;
  if (type === "checkout.session.completed" && o.mode === "payment" && o.payment_status === "paid" && (o.amount_total ?? 0) > 0) {
    rec = { id: o.id, kind: "checkout", amount: o.amount_total ?? 0, currency: o.currency, customer: o.customer ?? null,
      userId: o.metadata?.user_id ?? null, email: o.customer_details?.email ?? o.customer_email ?? null, created: o.created, item: itemOf(o.metadata) };
  } else if (type === "invoice.paid" && (o.amount_paid ?? 0) > 0) {
    const isSubscription = Boolean(o.parent?.subscription_details || o.subscription);
    if (!isSubscription && await matchingCheckout(env, product, o)) return false;
    const meta = o.parent?.subscription_details?.metadata ?? o.subscription_details?.metadata ?? o.metadata ?? {};
    rec = { id: o.id, kind: "invoice", amount: o.amount_paid, currency: o.currency, customer: o.customer ?? null,
      userId: meta.user_id ?? null, email: o.customer_email ?? null, created: o.status_transitions?.paid_at ?? o.created,
      item: itemOf(meta) ?? o.lines?.data?.[0]?.description ?? (o.billing_reason === "subscription_cycle" ? "renewal" : null) };
  } else if (type === "charge.refunded" && (o.amount_refunded ?? 0) > 0) {
    rec = { id: `refund_${o.id}`, kind: "refund", amount: -o.amount_refunded, currency: o.currency, customer: o.customer ?? null,
      userId: o.metadata?.user_id ?? null, email: o.billing_details?.email ?? o.receipt_email ?? null, created: o.created };
  }
  if (!rec) return false;
  const workspaceId: string | null = o.metadata?.workspace_id ?? o.parent?.subscription_details?.metadata?.workspace_id ?? o.subscription_details?.metadata?.workspace_id ?? null;
  let userId = rec.userId;
  if (!userId && rec.customer) userId = (await env.DB.prepare("SELECT user_id FROM people WHERE product = ? AND stripe_customer_id = ?").bind(product, rec.customer).first<{ user_id: string }>())?.user_id ?? null;
  if (!userId && rec.email) userId = (await env.DB.prepare("SELECT user_id FROM people WHERE product = ? AND lower(email) = lower(?)").bind(product, rec.email).first<{ user_id: string }>())?.user_id ?? null;
  /* Products where the workspace pays (e.g. a team plan): its first member stands for it. */
  if (!userId && workspaceId) userId = (await env.DB.prepare("SELECT user_id FROM people WHERE product = ? AND workspace_id = ? ORDER BY created_at LIMIT 1").bind(product, workspaceId).first<{ user_id: string }>())?.user_id ?? null;
  const person = userId ? await env.DB.prepare("SELECT first_touch FROM people WHERE product = ? AND user_id = ?").bind(product, userId).first<{ first_touch: string | null }>() : null;
  await env.DB.prepare(`INSERT OR REPLACE INTO payments (id, product, kind, amount_cents, currency, stripe_customer_id, user_id, email, created_at, attribution, livemode, item)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(rec.id, product, rec.kind, rec.amount, (rec.currency ?? "").toLowerCase(), rec.customer, userId, rec.email, new Date(rec.created * 1000).toISOString(), person?.first_touch ?? null, livemode ? 1 : 0, rec.item ? String(rec.item).slice(0, 80) : null).run();
  /* The invoice Stripe generated for this Checkout is the same purchase: drop it if already counted. */
  if (rec.kind === "checkout" && typeof o.invoice === "string") await env.DB.prepare("DELETE FROM payments WHERE id = ? AND product = ?").bind(o.invoice, product).run();
  if (userId) {
    await env.DB.prepare(`UPDATE people SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
        ltv_cents = (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE product = ?2 AND user_id = ?3 AND livemode = 1),
        currency = COALESCE(currency, ?4), updated_at = ?5 WHERE product = ?2 AND user_id = ?3`)
      .bind(rec.customer, product, userId, (rec.currency ?? "").toLowerCase(), new Date().toISOString()).run();
  }
  return true;
}

/** A one-off Checkout already counted for this invoice: same buyer, amount and currency within an hour. */
async function matchingCheckout(env: Env, product: string, inv: Obj): Promise<boolean> {
  const email = inv.customer_email ?? null;
  if (!inv.customer && !email) return false;
  const at = (inv.status_transitions?.paid_at ?? inv.created) * 1000;
  const hit = await env.DB.prepare(`SELECT 1 AS x FROM payments WHERE product = ?1 AND kind = 'checkout' AND amount_cents = ?2 AND currency = ?3
      AND (stripe_customer_id = ?4 OR lower(email) = lower(?5)) AND created_at BETWEEN ?6 AND ?7 LIMIT 1`)
    .bind(product, inv.amount_paid, (inv.currency ?? "").toLowerCase(), inv.customer ?? null, email, new Date(at - 3600e3).toISOString(), new Date(at + 3600e3).toISOString()).first();
  return Boolean(hit);
}

async function stripeList(key: string, path: string, params: Record<string, string>): Promise<Obj[]> {
  const out: Obj[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "100", ...params, ...(after ? { starting_after: after } : {}) });
    const res = await fetch(`https://api.stripe.com/v1/${path}?${q}`, { headers: { authorization: `Bearer ${key}`, "stripe-version": "2025-09-30.clover" } });
    if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data: Obj[]; has_more: boolean };
    out.push(...body.data);
    if (!body.has_more || !body.data.length) break;
    after = body.data[body.data.length - 1]!.id;
  }
  return out;
}

/** Nightly: every product with a read key. First run backfills everything (2,000 per kind max per run). */
export async function reconcileStripe(env: Env) {
  const results: string[] = [];
  for (const p of products(env.PRODUCTS)) {
    const key = env[`STRIPE_KEY_${keyName(p.id)}`];
    if (!key) continue;
    const backfilled = await env.DB.prepare("SELECT status FROM runs WHERE job = 'stripe_backfill' AND key = ?").bind(p.id).first<{ status: string }>();
    const since = backfilled?.status === "ok" ? Math.floor(Date.now() / 1000) - 3 * 86400 : 0;
    const gte: Record<string, string> = since ? { "created[gte]": String(since) } : {};
    try {
      let n = 0;
      for (const inv of await stripeList(key, "invoices", { status: "paid", ...gte })) n += Number(await ingest(env, p.id, "invoice.paid", inv, inv.livemode));
      for (const cs of await stripeList(key, "checkout/sessions", { status: "complete", ...gte })) n += Number(await ingest(env, p.id, "checkout.session.completed", cs, cs.livemode));
      for (const ch of await stripeList(key, "charges", gte)) if (ch.refunded || ch.amount_refunded > 0) n += Number(await ingest(env, p.id, "charge.refunded", ch, ch.livemode));
      await refreshRevenue(env, p.id);
      const job = since ? "stripe_reconcile" : "stripe_backfill";
      await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note) VALUES (?, ?, 'ok', ?, ?)").bind(job, since ? `${p.id}:${new Date().toISOString().slice(0, 10)}` : p.id, new Date().toISOString(), `${n} payments`).run();
      results.push(`${p.id}: ${n}`);
    } catch (e) {
      await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note) VALUES ('stripe_reconcile', ?, 'failed', ?, ?)")
        .bind(`${p.id}:${new Date().toISOString().slice(0, 10)}`, new Date().toISOString(), String((e as Error).message).slice(0, 300)).run();
    }
  }
  return results;
}

/**
 * Daily revenue in `days` (host '*') from live `payments`. The rollup writes it only for the days it
 * compacts (the last ten), so a backfill or a late webhook would otherwise never reach the charts.
 */
export async function refreshRevenue(env: Env, product: string) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO days (product, host, day, revenue_cents, rolled_up_at) SELECT product, '*', substr(created_at, 1, 10), 0, ? FROM payments WHERE product = ? AND livemode = 1 GROUP BY substr(created_at, 1, 10)").bind(now, product),
    env.DB.prepare("UPDATE days SET revenue_cents = COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.product = days.product AND substr(p.created_at, 1, 10) = days.day AND p.livemode = 1), 0) WHERE product = ? AND host = '*'").bind(product),
  ]);
}
