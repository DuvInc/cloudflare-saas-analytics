/*
  Funnels and a person's activity, both from event-level data (the period's compacted daily files,
  raw files for today). A person is the signed-in user, or before sign-up the consent cookie or the
  day's hash, joined to the user through `identities` (written by identify at sign-up), so a funnel
  can start on an anonymous landing and end on a server-side payment.
*/
import type { Env } from "./env";
import type { Raw } from "./aggregate";
import { dayEvents, dayEventsReadOnly } from "./explore";
import type { FunnelDef } from "./funnels";
import { utcDay } from "./identity";
import { pool } from "./pool";
import { ReadContext } from "./read-context";

export type Step = { kind: "page" | "event"; value: string; paths?: string[] };

export async function periodEvents(env: Env, product: string, days: number, context = new ReadContext(env)): Promise<Raw[]> {
  const today = utcDay(Date.now());
  const list = Array.from({ length: days }, (_, i) => utcDay(Date.now() - (days - 1 - i) * 86400_000));
  const parts = await pool(list, 6, async (day) => (await dayEvents(env, day, today, context)).filter((event) => event.product === product && !event.is_bot));
  return parts.flat().sort((a, b) => a.received_at - b.received_at);
}

export async function aliases(env: Env, product: string): Promise<Map<string, string>> {
  const rows = (await env.DB.prepare("SELECT kind, value, user_id FROM identities WHERE product = ?").bind(product).all<{ kind: string; value: string; user_id: string }>()).results ?? [];
  return new Map(rows.map((r) => [`${r.kind === "anon" ? "a" : "h"}:${r.value}`, r.user_id]));
}

async function aliasesByProduct(env: Env, productIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>(productIds.map((id) => [id, new Map()]));
  if (!productIds.length) return out;
  const placeholders = productIds.map(() => "?").join(", ");
  const rows = (await env.DB.prepare(`SELECT product, kind, value, user_id FROM identities WHERE product IN (${placeholders})`).bind(...productIds).all<{ product: string; kind: string; value: string; user_id: string }>()).results ?? [];
  for (const r of rows) out.get(r.product)?.set(`${r.kind === "anon" ? "a" : "h"}:${r.value}`, r.user_id);
  return out;
}

export function personOf(e: Raw, alias: Map<string, string>): string | null {
  if (e.user_id) return `u:${e.user_id}`;
  if (e.anon_id) { const u = alias.get(`a:${e.anon_id}`); return u ? `u:${u}` : `a:${e.anon_id}`; }
  if (e.day_hash) { const u = alias.get(`h:${e.day_hash}`); return u ? `u:${u}` : `h:${e.day_hash}`; }
  return null;
}

function compileStep(s: Step): (e: Raw) => boolean {
  if (s.kind === "event") return (e) => e.event === s.value;
  const matchers = (s.paths ?? [s.value]).map((pattern) => {
    if (!pattern.includes("*")) return (path: string) => path === pattern;
    const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return (path: string) => re.test(path);
  });
  return (e) => {
    if (e.event !== "$pageview") return false;
    const path = e.path || "/";
    return matchers.some((fn) => fn(path));
  };
}

const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

/**
 * People who did step 1, then step 2 after it, and so on, within the period. Counts per step,
 * median time from the previous step, and the whole funnel's conversion by the channel the person
 * first arrived from in the period.
 */
export function computeFunnel(events: Raw[], steps: Step[], alias: Map<string, string>) {
  const compiled = steps.map(compileStep);
  const byPerson = new Map<string, Raw[]>();
  for (const e of events) {
    const p = personOf(e, alias);
    if (p) (byPerson.get(p) ?? byPerson.set(p, []).get(p)!).push(e);
  }
  const reached = steps.map(() => 0);
  const gaps: number[][] = steps.map(() => []);
  const channels = new Map<string, { entered: number; converted: number }>();
  for (const evs of byPerson.values()) {
    let i = 0, last = 0;
    for (const e of evs) {
      if (i < compiled.length && compiled[i]!(e)) {
        if (i > 0) gaps[i]!.push(e.received_at - last);
        reached[i]!++;
        last = e.received_at;
        i++;
      }
    }
    if (i === 0) continue;
    const entry = evs.find((e) => e.event === "$pageview");
    const ch = entry?.ai_source ? `AI \u00b7 ${entry.ai_source}` : entry?.channel || (evs[0]?.origin === "server" ? "Server" : "Direct");
    const c = channels.get(ch) ?? { entered: 0, converted: 0 };
    c.entered++;
    if (i === steps.length) c.converted++;
    channels.set(ch, c);
  }
  return {
    steps: steps.map((s, i) => ({ ...s, people: reached[i]!, median_ms: i ? median(gaps[i]!) : null })),
    byChannel: [...channels.entries()].map(([k, c]) => ({ k, ...c })).sort((a, b) => b.entered - a.entered || a.k.localeCompare(b.k)).slice(0, 12),
  };
}

/**
 * Constant-memory streaming evaluation of multiple funnels across up to 90 days.
 * Reads each day once via ReadContext.dayReadOnly in small batches of 6 days, keeping only tiny
 * per-person progress scalars in memory instead of materializing all raw events across 90 days.
 */
export async function computeProductFunnels(env: Env, defs: FunnelDef[], days: number, context = new ReadContext(env)) {
  const activeDefs = defs.filter((d) => !d.unavailable);
  const productIds = [...new Set(activeDefs.map((d) => d.product))];
  const aliasMap = await aliasesByProduct(env, productIds);

  type Touch = { firstOrigin: string; entryCh: string | null };
  type FunnelState = {
    def: FunnelDef;
    compiled: ((e: Raw) => boolean)[];
    reached: number[];
    gaps: number[][];
    people: Map<string, { i: number; last: number }>;
  };

  const byProduct = new Map<string, { alias: Map<string, string>; touches: Map<string, Touch>; funnels: FunnelState[] }>();
  for (const id of productIds) {
    byProduct.set(id, { alias: aliasMap.get(id) ?? new Map(), touches: new Map(), funnels: [] });
  }
  const stateByDef = new Map<FunnelDef, FunnelState>();
  for (const def of activeDefs) {
    const st: FunnelState = {
      def,
      compiled: def.steps.map(compileStep),
      reached: def.steps.map(() => 0),
      gaps: def.steps.map(() => []),
      people: new Map(),
    };
    stateByDef.set(def, st);
    byProduct.get(def.product)!.funnels.push(st);
  }

  if (productIds.length > 0) {
    const now = Date.now();
    const today = utcDay(now);
    const list = Array.from({ length: days }, (_, i) => utcDay(now - (days - 1 - i) * 86400_000));
    const CHUNK = 6;
    for (let offset = 0; offset < list.length; offset += CHUNK) {
      const slice = list.slice(offset, offset + CHUNK);
      const batch = await Promise.all(slice.map((day) => dayEventsReadOnly(env, day, today, context)));
      for (const rawDay of batch) {
        if (!rawDay.length) continue;
        const relevant = rawDay.filter((e) => !e.is_bot && byProduct.has(e.product));
        if (!relevant.length) continue;
        relevant.sort((a, b) => a.received_at - b.received_at);
        for (const e of relevant) {
          const prod = byProduct.get(e.product)!;
          const p = personOf(e, prod.alias);
          if (!p) continue;
          let touch = prod.touches.get(p);
          if (!touch) {
            touch = { firstOrigin: String(e.origin ?? ""), entryCh: null };
            prod.touches.set(p, touch);
          }
          if (touch.entryCh === null && e.event === "$pageview") {
            touch.entryCh = e.ai_source ? `AI \u00b7 ${e.ai_source}` : (e.channel || "");
          }
          for (const f of prod.funnels) {
            const cur = f.people.get(p);
            const idx = cur ? cur.i : 0;
            if (idx < f.compiled.length && f.compiled[idx]!(e)) {
              if (idx > 0) f.gaps[idx]!.push(e.received_at - cur!.last);
              f.reached[idx]!++;
              if (!cur) f.people.set(p, { i: 1, last: e.received_at });
              else { cur.i = idx + 1; cur.last = e.received_at; }
            }
          }
        }
      }
    }
  }

  const out = defs.map((def) => {
    if (def.unavailable) {
      return { ...def, steps: def.steps.map((step) => ({ ...step, people: 0, median_ms: null })), byChannel: [], entered: 0, converted: 0 };
    }
    const st = stateByDef.get(def)!;
    const prod = byProduct.get(def.product)!;
    const channels = new Map<string, { entered: number; converted: number }>();
    for (const [p, progress] of st.people) {
      const touch = prod.touches.get(p);
      const ch = touch?.entryCh || (touch?.firstOrigin === "server" ? "Server" : "Direct");
      const c = channels.get(ch) ?? { entered: 0, converted: 0 };
      c.entered++;
      if (progress.i === def.steps.length) c.converted++;
      channels.set(ch, c);
    }
    const steps = def.steps.map((s, i) => ({ ...s, people: st.reached[i]!, median_ms: i ? median(st.gaps[i]!) : null }));
    const byChannel = [...channels.entries()].map(([k, c]) => ({ k, ...c })).sort((a, b) => b.entered - a.entered || a.k.localeCompare(b.k)).slice(0, 12);
    return { ...def, steps, byChannel, entered: steps[0]?.people ?? 0, converted: steps.at(-1)?.people ?? 0 };
  });
  out.sort((a, b) => (b.converted - a.converted) || (b.entered - a.entered));
  return out;
}

/** A person's events in the period, newest first, scanning newest days first and stopping at 800. */
export async function personActivity(env: Env, product: string, userId: string, days: number, context = new ReadContext(env)) {
  const alias = await aliases(env, product);
  const me = `u:${userId}`;
  const now = Date.now();
  const today = utcDay(now);
  const newestFirst = Array.from({ length: days }, (_, i) => utcDay(now - i * 86400_000));
  const collected: Raw[] = [];
  const CHUNK = 6;
  for (let offset = 0; offset < newestFirst.length && collected.length < 800; offset += CHUNK) {
    const slice = newestFirst.slice(offset, offset + CHUNK);
    const batch = await Promise.all(slice.map((day) => dayEventsReadOnly(env, day, today, context)));
    for (const dayEvs of batch) {
      if (!dayEvs.length) continue;
      const matches = dayEvs.filter((e) => e.product === product && !e.is_bot && personOf(e, alias) === me);
      if (!matches.length) continue;
      matches.sort((a, b) => b.received_at - a.received_at);
      for (const e of matches) {
        collected.push(e);
        if (collected.length >= 800) break;
      }
      if (collected.length >= 800) break;
    }
  }
  return collected.map((e) => ({
    at: e.received_at, event: e.event, origin: e.origin, host: e.host, path: e.path, channel: e.channel, ai_source: e.ai_source,
    referrer_host: e.referrer_host, country: e.country, city: e.city, device: e.device, browser: e.browser, os: e.os,
    engaged_ms: e.engaged_ms, props: e.props, visit_id: e.visit_id,
  }));
}
