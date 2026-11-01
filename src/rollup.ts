/*
  Hourly: close every finished UTC day that has no 'ok' row in `runs` (job 'rollup'), oldest first.

  1. Read the Basin sink's raw files (`raw/...`, NDJSON gzip, one every <= 5 min) whose upload
     falls in [day - 1 h, day + 1 + 30 min] and keep the events *received* that day.
  2. Sessionize (aggregate.ts), then write the day as one compacted file set:
     `daily/<day>/part-NNN.ndjson.gz`, events sorted, visit_id filled. This is the system of record.
  3. Upsert the `days` rows (D1), then the ledger row last: a crash leaves the day due, and the
     redo writes the same files and rows again.
  4. Delete raw files uploaded before the day's end once the previous day is also closed, so
     every raw file is read by the two days it can hold.

  Raw files land under `raw/` with Hive partitions of the sink's processing time; this code only
  trusts `received_at` inside each line and each object's `uploaded` time, never the path.
*/
import { gunzipSync } from "node:zlib";
import { aggregate, sessionize, type Raw } from "./aggregate";
import type { Env } from "./env";
import { pool } from "./pool";
import type { ReadContext } from "./read-context";
import { utcDay } from "./identity";

const SETTLE_MS = 30 * 60_000;
const BACKFILL_DAYS = 10;
const DAYS_PER_RUN = 3;
const PART_EVENTS = 50_000;

export async function listRaw(env: Env, from: number, to: number): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "raw/", cursor, limit: 1000 });
    for (const o of page.objects) {
      const t = o.uploaded.getTime();
      if (t >= from && t <= to) out.push(o);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export async function readLines(env: Env, key: string): Promise<Raw[]> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return [];
  const gz = key.endsWith(".gz") || obj.httpMetadata?.contentEncoding === "gzip" || obj.httpMetadata?.contentType === "application/gzip";
  let text: string;
  if (gz) {
    // Basin writes several gzip members back to back; DecompressionStream stops at the first.
    text = gunzipSync(new Uint8Array(await obj.arrayBuffer())).toString("utf8");
  } else text = await obj.text();
  const out: Raw[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped */ }
  }
  return out;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function eventsReceived(env: Env, from: number, to: number): Promise<{ events: Raw[]; files: R2Object[] }> {
  const files = await listRaw(env, from - 3600_000, to + SETTLE_MS);
  const parts = await pool(files, 6, (f) => readLines(env, f.key));
  const events: Raw[] = [];
  for (const part of parts) {
    for (const e of part) {
      if (typeof e.received_at === "number" && e.received_at >= from && e.received_at < to) events.push(e);
    }
  }
  return { events, files };
}

/**
 * Compacts settled UTC hours of `today` into `cache/hours/<today>/<HH>.ndjson.gz` so cold dashboard
 * reads fetch <= 24 hourly files + ~12 tail raw files instead of ~288 five-minute Basin files.
 */
export async function compactTodayHours(env: Env, now = Date.now()): Promise<number> {
  const today = utcDay(now);
  const dayStart = Date.parse(`${today}T00:00:00Z`);
  const maxSettledHour = Math.floor((now - SETTLE_MS - dayStart) / 3600_000) - 1;
  if (maxSettledHour < 0) return 0;

  const existing = await env.BUCKET.list({ prefix: `cache/hours/${today}/`, limit: 100 });
  const have = new Set(existing.objects.map((o) => o.key));
  const missing: number[] = [];
  for (let h = 0; h <= Math.min(maxSettledHour, 23); h++) {
    const key = `cache/hours/${today}/${String(h).padStart(2, "0")}.ndjson.gz`;
    if (!have.has(key)) missing.push(h);
  }
  if (!missing.length) return 0;

  const minH = missing[0]!;
  const maxH = missing[missing.length - 1]!;
  const winFrom = dayStart + minH * 3600_000;
  const winTo = dayStart + (maxH + 1) * 3600_000;
  const files = await listRaw(env, winFrom - 3600_000, winTo + SETTLE_MS);
  const parts = await pool(files, 6, (f) => readLines(env, f.key));
  const buckets = new Map<number, Raw[]>(missing.map((h) => [h, []]));
  for (const part of parts) {
    for (const e of part) {
      if (typeof e.received_at !== "number" || e.received_at < winFrom || e.received_at >= winTo) continue;
      const h = Math.floor((e.received_at - dayStart) / 3600_000);
      buckets.get(h)?.push(e);
    }
  }
  await pool(missing, 4, async (h) => {
    const rows = buckets.get(h) ?? [];
    rows.sort((a, b) => (a.received_at - b.received_at) || ((a.ts ?? 0) - (b.ts ?? 0)));
    const body = rows.length ? rows.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
    const key = `cache/hours/${today}/${String(h).padStart(2, "0")}.ndjson.gz`;
    await env.BUCKET.put(key, await gzip(body), { httpMetadata: { contentType: "application/gzip" } });
  });
  return missing.length;
}

export async function returningSet(env: Env, day: string, anons: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < anons.length; i += 90) {
    const chunk = anons.slice(i, i + 90);
    const rows = await env.DB.prepare(`SELECT anon_id FROM anon_first WHERE first_day < ?1 AND anon_id IN (${chunk.map((_, j) => `?${j + 2}`).join(",")})`)
      .bind(day, ...chunk).all<{ anon_id: string }>();
    for (const r of rows.results ?? []) out.add(r.anon_id);
  }
  return out;
}

export async function rollupDay(env: Env, day: string): Promise<{ events: number; files: string[]; rawFiles: R2Object[] }> {
  const from = Date.parse(`${day}T00:00:00Z`), to = from + 86400_000;
  const { events, files: rawFiles } = await eventsReceived(env, from, to);
  const visits = sessionize(events);
  const anons = [...new Set(events.map((e) => e.anon_id).filter(Boolean) as string[])];
  const rows = aggregate(day, events, visits, await returningSet(env, day, anons));

  /* Compacted files: overwrite the day's set (a redo may have fewer parts: drop the extras). */
  const written: string[] = [];
  for (let i = 0; i * PART_EVENTS < events.length; i++) {
    const key = `daily/${day}/part-${String(i).padStart(3, "0")}.ndjson.gz`;
    const body = events.slice(i * PART_EVENTS, (i + 1) * PART_EVENTS).map((e) => JSON.stringify(e)).join("\n") + "\n";
    await env.BUCKET.put(key, await gzip(body), { httpMetadata: { contentType: "application/gzip" } });
    written.push(key);
  }
  const old = await env.BUCKET.list({ prefix: `daily/${day}/` });
  const stale = old.objects.map((o) => o.key).filter((k) => !written.includes(k));
  if (stale.length) await env.BUCKET.delete(stale);

  /* Live revenue per product for the day, from payments (webhooks + reconciliation, livemode = 1 only). */
  const rev = await env.DB.prepare("SELECT product, SUM(amount_cents) AS c FROM payments WHERE substr(created_at, 1, 10) = ? AND livemode = 1 GROUP BY product").bind(day).all<{ product: string; c: number }>();
  const revenue = new Map((rev.results ?? []).map((r) => [r.product, r.c]));

  const now = new Date().toISOString();
  const stmts = rows.map((r) => env.DB.prepare(`INSERT OR REPLACE INTO days (product, host, day, views, visitors, visits, bounces, engaged_ms, returning_visitors, signups, events, bot_views, revenue_cents,
      pages, entries, referrers, channels, ai_sources, utm_sources, utm_campaigns, countries, cities, devices, browsers, os, langs, custom_events, vitals, hourly, rolled_up_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(r.product, r.host, r.day, r.views, r.visitors, r.visits, r.bounces, r.engaged_ms, r.returning, r.signups, r.events, r.bot_views,
      r.host === "*" ? revenue.get(r.product) ?? 0 : 0,
      JSON.stringify(r.pages), JSON.stringify(r.entries), JSON.stringify(r.referrers), JSON.stringify(r.channels), JSON.stringify(r.ai_sources),
      JSON.stringify(r.utm_sources), JSON.stringify(r.utm_campaigns), JSON.stringify(r.countries), JSON.stringify(r.cities), JSON.stringify(r.devices),
      JSON.stringify(r.browsers), JSON.stringify(r.os), JSON.stringify(r.langs), JSON.stringify(r.custom_events), JSON.stringify(r.vitals), JSON.stringify(r.hourly), now));
  /* A product with revenue but no traffic that day still gets its '*' row. */
  for (const [product, cents] of revenue) {
    if (!rows.some((r) => r.product === product && r.host === "*")) {
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO days (product, host, day, revenue_cents, rolled_up_at) VALUES (?, '*', ?, ?, ?)").bind(product, day, cents, now));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { events: events.length, files: written, rawFiles };
}

export async function runRollups(env: Env, now = Date.now()): Promise<string[]> {
  const done: string[] = [];
  const due: string[] = [];
  for (let i = BACKFILL_DAYS; i >= 1; i--) {
    const day = utcDay(now - i * 86400_000);
    if (Date.parse(`${day}T00:00:00Z`) + 86400_000 + SETTLE_MS > now) continue;
    due.push(day);
  }
  if (due.length) {
    const ledger = await env.DB.prepare(`SELECT key, status FROM runs WHERE job = 'rollup' AND key IN (${due.map(() => "?").join(",")})`).bind(...due).all<{ key: string; status: string }>();
    const ok = new Set((ledger.results ?? []).filter((r) => r.status === "ok").map((r) => r.key));
    for (const day of due.filter((d) => !ok.has(d)).slice(0, DAYS_PER_RUN)) {
      try {
        const r = await rollupDay(env, day);
        await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note, files) VALUES ('rollup', ?, 'ok', ?, ?, ?)")
          .bind(day, new Date().toISOString(), `${r.events} events`, JSON.stringify(r.files)).run();
        /* Clean temporary hourly compactions for the now-closed day. */
        const hourTrash = await env.BUCKET.list({ prefix: `cache/hours/${day}/`, limit: 100 });
        if (hourTrash.objects.length) await env.BUCKET.delete(hourTrash.objects.map((o) => o.key));
        /* Raw files that can only hold this day or earlier: safe once the day before is closed too. */
        const prev = utcDay(Date.parse(`${day}T00:00:00Z`) - 86400_000);
        const prevOk = ok.has(prev) || done.includes(prev) || !(await env.DB.prepare("SELECT 1 FROM runs WHERE job = 'rollup' AND key < ? LIMIT 1").bind(day).first());
        if (prevOk) {
          const end = Date.parse(`${day}T00:00:00Z`) + 86400_000;
          const old = r.rawFiles.filter((o) => o.uploaded.getTime() < end).map((o) => o.key);
          for (let i = 0; i < old.length; i += 1000) await env.BUCKET.delete(old.slice(i, i + 1000));
        }
        done.push(day);
      } catch (e) {
        console.error(JSON.stringify({ event: "rollup_failed", day, reason: String((e as Error)?.message ?? e).slice(0, 300) }));
        await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note) VALUES ('rollup', ?, 'failed', ?, ?)")
          .bind(day, new Date().toISOString(), String((e as Error)?.message ?? e).slice(0, 300)).run();
        break;
      }
    }
  }
  await compactTodayHours(env, now);
  await env.DB.prepare("DELETE FROM recent_visits WHERE started_at < ?").bind(now - 3 * 86400_000).run();
  await pruneRetention(env, now);
  return done;
}

/** Once per UTC day, prune D1 tables aligned with R2 lifecycles (30d replays, 7d dead sessions/enrollments, 90d stripe dedupe). */
async function pruneRetention(env: Env, now: number) {
  const today = utcDay(now);
  const already = await env.DB.prepare("SELECT 1 FROM runs WHERE job = 'prune' AND key = ? AND status = 'ok'").bind(today).first();
  if (already) return;
  const replayCutoff = utcDay(now - 30 * 86400_000);
  const sevenDaysAgoMs = now - 7 * 86400_000;
  const sevenDaysAgoIso = new Date(sevenDaysAgoMs).toISOString();
  const ninetyDaysAgoIso = new Date(now - 90 * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM replay_sessions WHERE day < ?").bind(replayCutoff),
    env.DB.prepare("DELETE FROM replay_chunks WHERE day < ?").bind(replayCutoff),
    env.DB.prepare("DELETE FROM operator_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").bind(sevenDaysAgoMs, sevenDaysAgoIso),
    env.DB.prepare("DELETE FROM operator_enrollments WHERE expires_at < ?").bind(sevenDaysAgoMs),
    env.DB.prepare("DELETE FROM stripe_events WHERE at < ?").bind(ninetyDaysAgoIso),
    env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note) VALUES ('prune', ?, 'ok', ?, '30d replays, 7d auth, 90d stripe')")
      .bind(today, new Date(now).toISOString()),
  ]);
}

/** Today so far (or any open window), straight from settled hourly compactions + tail raw files. */
export async function liveRows(env: Env, now = Date.now(), context?: ReadContext) {
  const day = utcDay(now);
  const from = Date.parse(`${day}T00:00:00Z`);
  const events = context ? await context.day(day, day) : (await eventsReceived(env, from, now + 1)).events;
  const visits = sessionize(events);
  const anons = [...new Set(events.map((e) => e.anon_id).filter(Boolean) as string[])];
  return aggregate(day, events, visits, await returningSet(env, day, anons));
}
