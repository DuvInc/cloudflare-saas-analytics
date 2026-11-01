/*
  Filtered views (the dashboard's "click a value to filter"): the daily rows of `days` are
  pre-aggregated and cannot be cut by a dimension, so a filtered request re-reads the period's
  events (compacted daily files, raw files for days not compacted yet), keeps the visits that match
  every filter, and aggregates them with the same code as the nightly rollup.

  A filter matches a visit, not an event (as Rybbit and Plausible do): `channel:AI` keeps whole
  visits that arrived from an AI assistant, with every page they saw.
*/
import type { Env } from "./env";
import { aggregate, sessionize, type DayRow, type Raw, type Visit } from "./aggregate";
import { utcDay } from "./identity";
import { returningSet } from "./rollup";
import { pool } from "./pool";
import { ReadContext } from "./read-context";

export const DIMENSIONS = ["channel", "referrer", "ai", "utm_source", "utm_campaign", "entry", "page", "country", "city", "device", "browser", "os", "lang", "event"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Op = "is" | "not" | "contains";
export type Filter = { dim: Dimension; op?: Op; value: string };

/** `dim:value` is, `dim!:value` is not, `dim~:value` contains (case-insensitive). */
export function parseFilters(params: URLSearchParams): Filter[] {
  const out: Filter[] = [];
  for (const raw of params.getAll("f").slice(0, 8)) {
    const i = raw.indexOf(":");
    if (i <= 0) continue;
    let dim = raw.slice(0, i);
    let op: Op = "is";
    if (dim.endsWith("!")) { op = "not"; dim = dim.slice(0, -1); } else if (dim.endsWith("~")) { op = "contains"; dim = dim.slice(0, -1); }
    if ((DIMENSIONS as readonly string[]).includes(dim)) out.push({ dim: dim as Dimension, op, value: raw.slice(i + 1).slice(0, 300) });
  }
  return out;
}

const lang = (e: Raw) => (e.lang || e.langs?.split(",")[0] || "?").slice(0, 2);

/** The values a visit has on a dimension (the keys the tops show). */
function valuesOf(dim: Dimension, v: Visit, evs: Raw[]): string[] {
  const en = v.entry;
  const views = evs.filter((e) => e.event === "$pageview");
  switch (dim) {
    case "channel": return [en?.channel || "Direct"];
    case "referrer": return en?.referrer_host ? [en.referrer_host] : [];
    case "ai": return en?.ai_source ? [en.ai_source] : [];
    case "utm_source": return en?.utm_source ? [en.utm_source] : [];
    case "utm_campaign": return en?.utm_campaign ? [en.utm_campaign] : [];
    case "entry": return [en?.path || "/"];
    case "page": return views.map((e) => e.path || "/");
    case "country": return views.map((e) => e.country || "??");
    case "city": return views.filter((e) => e.city).map((e) => `${e.city}, ${e.country}`);
    case "device": return views.map((e) => e.device || "?");
    case "browser": return views.map((e) => e.browser || "?");
    case "os": return views.map((e) => e.os || "?");
    case "lang": return views.map(lang);
    case "event": return evs.map((e) => e.event);
  }
}

/** A filter matches a visit: one of its values is (or contains) the value; "not": none is. */
export function matches(f: Filter, v: Visit, evs: Raw[]): boolean {
  const vals = valuesOf(f.dim, v, evs);
  const op = f.op ?? "is";
  if (op === "contains") { const q = f.value.toLowerCase(); return vals.some((x) => x.toLowerCase().includes(q)); }
  const hit = vals.includes(f.value);
  return op === "not" ? !hit : hit;
}

export async function dayEvents(env: Env, day: string, today: string, context = new ReadContext(env)): Promise<Raw[]> {
  return context.day(day, today);
}

export async function dayEventsReadOnly(env: Env, day: string, today: string, context = new ReadContext(env)): Promise<readonly Raw[]> {
  return context.dayReadOnly(day, today);
}

/** The product's row of one day, for the visits matching every filter. */
async function filteredDay(env: Env, product: string, host: string, day: string, today: string, filters: Filter[], context: ReadContext): Promise<DayRow | null> {
  const all = (await dayEvents(env, day, today, context)).filter((e) => e.product === product);
  if (!all.length) return null;
  const visits = sessionize(all);
  const byVisit = new Map<string, Raw[]>();
  for (const e of all) if (e.visit_id) (byVisit.get(e.visit_id) ?? byVisit.set(e.visit_id, []).get(e.visit_id)!).push(e);
  const kept = visits.filter((v) => filters.every((f) => matches(f, v, byVisit.get(v.id) ?? [])));
  const ids = new Set(kept.map((v) => v.id));
  const events = all.filter((e) => e.visit_id && ids.has(e.visit_id));
  const anons = [...new Set(events.map((e) => e.anon_id).filter(Boolean) as string[])];
  const rows = aggregate(day, events, kept, await returningSet(env, day, anons));
  return rows.find((r) => r.host === host) ?? null;
}

/*
  A closed day never changes, so its filtered row is kept in R2 (`cache/explore/...`, expired by a
  lifecycle rule after 30 days). The Cache API would be simpler but does nothing on workers.dev.
  Only finalized, ledger-backed days are persisted. Open days have a short, refreshable memory cache.
*/
/** Rows shaped like D1 `days` rows (tops as JSON strings), one per day with data. */
export async function filteredDays(env: Env, product: string, host: string, from: string, days: number, filters: Filter[], context = new ReadContext(env)) {
  const today = utcDay(Date.now());
  const sig = filters.map((f) => `${f.dim}${f.op === "not" ? "!" : f.op === "contains" ? "~" : ""}:${f.value}`).sort().join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([product, host, sig].join("\n")));
  const hash = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  const list: string[] = [];
  for (let i = 0; i < days; i++) {
    const day = utcDay(Date.parse(`${from}T00:00:00Z`) + i * 86400_000);
    if (day <= today) list.push(day);
  }
  const manifests = await context.manifests();
  const rows = await pool(list, 6, async (day) => {
    const manifest = day === today ? undefined : manifests.get(day);
    if (manifest && (JSON.parse(manifest.files) as string[]).length === 0) return null;
    const version = manifest ? encodeURIComponent(manifest.ran_at) : "open";
    const key = `cache/explore/v2/${hash}/${day}/${version}.json`;
    return context.cached(key, async () => {
      if (manifest && !context.fresh) {
        const hit = await env.BUCKET.get(key);
        if (hit) return await hit.json<DayRow | null>();
      }
      const row = await filteredDay(env, product, host, day, today, filters, context);
      if (manifest) await env.BUCKET.put(key, JSON.stringify(row), { httpMetadata: { contentType: "application/json" } });
      return row;
    }, (row) => JSON.stringify(row).length * 2 + 1024);
  });
  const out: Record<string, any>[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row) continue;
    const r: Record<string, any> = { ...row, returning_visitors: row.returning, revenue_cents: 0, live: list[i] === today };
    for (const k of ["pages", "entries", "referrers", "channels", "ai_sources", "utm_sources", "utm_campaigns", "countries", "cities", "devices", "browsers", "os", "langs", "custom_events", "vitals", "hourly"]) r[k] = JSON.stringify((row as any)[k]);
    out.push(r);
  }
  return out;
}

/** Revenue and people follow a filter only on the source dimensions (a person's first touch). */
export const FIRST_TOUCH: Partial<Record<Dimension, string>> = { channel: "$.channel", referrer: "$.referrer_host", ai: "$.ai_source", utm_source: "$.utm_source", utm_campaign: "$.utm_campaign", entry: "$.entry_path", country: "$.country" };
