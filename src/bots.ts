/*
  Machines reading the sites: verified bots from Cloudflare's zone logs (GraphQL
  httpRequestsAdaptiveGroups), for every product domain plus `BOTS.extraSites`. Replaces the
  bots-analytics Worker (2026-10-31); same row format, so its archive (2026-08-19 to 2026-10-30)
  was copied in unchanged and summed into D1 by a one-time import (git history of this file).

  Humans who arrive from an assistant are not here: they are web visits with the channel "AI"
  (tracker, channels.ts). This file is what the assistants and crawlers themselves fetched, which
  no JavaScript tracker can see.

  Hourly (the cron at :17): each closed hour of the last 20 with no `ok` in `runs` (job `bots`) is
  read twice, verified bots with their paths, and every request by host and kind (the denominator),
  then written to R2:
    bots/<zone>/crawl/<day>/<HH>.ndjson.gz   {hour, day, host, path, kind, bot_category, bot_name, country, status, requests}
    bots/<zone>/totals/<day>/<HH>.ndjson.gz  {hour, day, host, kind, audience: bot|other, requests}
    bots/<zone>/delivery/<day>.ndjson.gz     Analytics Engine sites: what their Worker served agents
  A closed day is then summed into D1 `bot_days` (one row per bot), `traffic_days`, `delivery_days`.
  The source keeps 24 hours: a failed hour is retried by the next runs, after that it is lost.
  The GraphQL API caps a result at 10,000 groups without saying so: a full window is halved down to
  15 minutes.

  The family is derived at read time from the name and Cloudflare's category, so a rule fixed later
  applies to the whole history.
*/
import type { Env } from "./env";
import { gunzipSync } from "node:zlib";
import { pool } from "./pool";
import { products } from "./products";
import { utcDay } from "./identity";

export type Family = "answers" | "ai_search" | "ai_training" | "search" | "preview" | "seo" | "other";
export const FAMILIES: Family[] = ["answers", "ai_search", "ai_training", "search", "preview", "seo", "other"];
export const AI_FAMILIES: Family[] = ["answers", "ai_search", "ai_training"];

const NAME_RULES: [RegExp, Family][] = [
  /* An assistant fetching a page live because a person asked it something. */
  [/^(ChatGPT-User|Claude-User|Perplexity-User|MistralAI-User|DuckAssistBot|Gemini-User|Google-NotebookLM|meta-externalfetcher|Manus|Devin|Operator)/i, "answers"],
  /* Building an assistant's search index: what makes a page citable in an answer. */
  [/^(OAI-SearchBot|Claude-SearchBot|PerplexityBot|YouBot|Amzn-SearchBot|Andibot|ExaBot|PhindBot)/i, "ai_search"],
  /* Collecting text to train models. */
  [/^(GPTBot|ClaudeBot|anthropic-ai|CCBot|Google-Extended|GoogleOther|Applebot-Extended|Bytespider|meta-externalagent|FacebookBot|Amazonbot|cohere-ai|AI2Bot|Diffbot|ImagesiftBot|Timpibot|omgili)/i, "ai_training"],
  [/^(Googlebot|bingbot|BingPreview|DuckDuckBot|YandexBot|Baiduspider|Applebot|Yeti|PetalBot|SeznamBot|Qwantbot|Mojeek)/i, "search"],
  [/^(facebookexternalhit|LinkedInBot|Slackbot|Discordbot|TelegramBot|TwitterBot|WhatsApp|Pinterest|redditbot|SkypeUriPreview)/i, "preview"],
  [/^(AhrefsBot|SemrushBot|MJ12bot|DotBot|Screaming|SEOkicks|serpstat|DataForSeo)/i, "seo"],
];
const CATEGORY_RULES: Record<string, Family> = {
  "AI Assistant": "answers", "AI Search": "ai_search", "AI Crawler": "ai_training",
  "Search Engine Crawler": "search", "Page Preview": "preview", "Search Engine Optimization": "seo",
};
export function familyOf(bot: string, category: string): Family {
  for (const [re, f] of NAME_RULES) if (re.test(bot)) return f;
  return CATEGORY_RULES[category] ?? "other";
}

/* ---------------------------------------------------------------- naming (from bots-analytics) */

export function kindOf(path: string): string {
  if (/\/llms(-full)?\.txt$/.test(path)) return "llms";
  if (path.endsWith(".md")) return "twin";
  if (path.startsWith("/og/")) return "og";
  if (/\/(sitemap[^/]*\.xml|robots\.txt|rss\.xml|updates\.xml)$/.test(path)) return "feed";
  if (/(^|\/)(_astro|fonts|logos|icons|illustrations|screenshots)\//.test(path)) return "asset";
  if (/\.(css|js|woff2?|png|jpe?g|webp|avif|svg|ico|txt|xml|json|map)$/.test(path)) return "asset";
  return "page";
}

const KNOWN = /(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|Google-Extended|GoogleOther|Applebot-Extended|meta-externalagent|meta-externalfetcher|FacebookBot|Amazonbot|CCBot|cohere-ai|Bytespider|DuckAssistBot|MistralAI-User|bingbot|BingPreview|Googlebot|SemrushBot|AhrefsBot|Applebot|DuckDuckBot|YandexBot|Baiduspider|facebookexternalhit|LinkedInBot|Slackbot|Discordbot|TelegramBot|TwitterBot|WhatsApp|Yeti)/i;
/** A verified bot's name, never '': the known list, else a token the User-Agent declares itself. */
export function botName(userAgent: string): string {
  const known = userAgent.match(KNOWN)?.[1];
  if (known) return known;
  const selfDeclared = userAgent.match(/([A-Za-z0-9][A-Za-z0-9._+-]*(?:bot|crawler|spider|agent|fetcher)[A-Za-z0-9._+-]*)/i)?.[1];
  if (selfDeclared) return selfDeclared.slice(0, 40);
  const product = userAgent.trim().split(/[\s/;()]+/)[0] ?? "";
  if (/^(Mozilla|Opera)$/i.test(product)) {
    const compatible = userAgent.match(/\(\s*compatible;\s*([A-Za-z0-9][A-Za-z0-9._+-]*)/i)?.[1];
    if (compatible && !/^(Mozilla|Opera)$/i.test(compatible)) return compatible.slice(0, 40);
    const operator = userAgent.match(/\+https?:\/\/(?:www\.)?([A-Za-z0-9.-]+)/i)?.[1];
    if (operator) return operator.slice(0, 40);
  }
  return product ? product.slice(0, 40) : "unknown";
}

/* ---------------------------------------------------------------- sites */

export type BotSite = { id: string; name: string; zone: string; delivery?: string };
type BotsConfig = { since?: string; extraSites?: BotSite[]; delivery?: Record<string, string> };
export function botsConfig(env: Env): BotsConfig {
  const raw = (env as any).BOTS;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) ?? {};
}
export function botSites(env: Env): BotSite[] {
  const c = botsConfig(env);
  return [...products(env.PRODUCTS).map((p): BotSite => ({ id: p.id, name: p.name, zone: p.domain })), ...(c.extraSites ?? [])]
    .map((s) => ({ ...s, delivery: s.delivery ?? c.delivery?.[s.zone] }));
}
export const siteById = (env: Env, id: string) => botSites(env).find((s) => s.id === id) ?? null;

/* ---------------------------------------------------------------- the source */

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const GROUP_LIMIT = 10_000;
const HOUR_MS = 3600_000;
const BACKFILL_HOURS = 20;
const MIN_WINDOW_MS = 15 * 60_000;
const WINDOWS_PER_RUN = 60;

type ZoneRow = { count: number; dimensions: { clientRequestHTTPHost: string; clientRequestPath: string; userAgent: string; verifiedBotCategory: string; clientCountryName: string; edgeResponseStatus: number } };

async function zoneIds(env: Env): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let page = 1;
  let totalPages = 1;
  do {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`, { headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` } });
    const b = (await r.json()) as { success: boolean; result?: { id: string; name: string }[]; result_info?: { total_pages?: number }; errors?: { message: string }[] };
    if (!b.success) throw new Error(`zones: ${b.errors?.[0]?.message ?? `HTTP ${r.status}`}`);
    for (const z of b.result ?? []) out.set(z.name, z.id);
    totalPages = Math.min(b.result_info?.total_pages ?? 1, 20);
    page++;
  } while (page <= totalPages);
  return out;
}

async function readWindow(env: Env, zoneId: string, since: number, until: number, botsOnly: boolean): Promise<ZoneRow[]> {
  const r = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `query W($zone: String!, $since: Time!, $until: Time!, $limit: Int!) { viewer { zones(filter: { zoneTag: $zone }) {
        httpRequestsAdaptiveGroups(limit: $limit, filter: { datetime_geq: $since, datetime_lt: $until${botsOnly ? ', verifiedBotCategory_neq: ""' : ""} }, orderBy: [count_DESC]) {
          count dimensions { clientRequestHTTPHost ${botsOnly ? "clientRequestPath userAgent clientCountryName edgeResponseStatus" : "clientRequestPath"} verifiedBotCategory }
        } } } }`,
      variables: { zone: zoneId, since: new Date(since).toISOString(), until: new Date(until).toISOString(), limit: GROUP_LIMIT },
    }),
  });
  const b = (await r.json()) as { data?: { viewer: { zones: { httpRequestsAdaptiveGroups: ZoneRow[] }[] } }; errors?: { message: string }[] | null };
  if (b.errors?.length) throw new Error(`GraphQL: ${b.errors[0]!.message}`);
  if (!b.data) throw new Error(`GraphQL: no data (HTTP ${r.status})`);
  const rows = b.data.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? [];
  if (rows.length >= GROUP_LIMIT && until - since > MIN_WINDOW_MS) {
    const mid = since + (until - since) / 2;
    const [a, c] = await Promise.all([readWindow(env, zoneId, since, mid, botsOnly), readWindow(env, zoneId, mid, until, botsOnly)]);
    return [...a, ...c];
  }
  return rows;
}

/** Sums rows identical on every field but `requests`. */
function fold<T extends Record<string, string | number>>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const row of rows) {
    const k = Object.entries(row).filter(([f]) => f !== "requests").map(([, v]) => String(v)).join("\u0000");
    const seen = out.get(k);
    if (seen) (seen as any).requests += row.requests as number;
    else out.set(k, { ...row });
  }
  return [...out.values()];
}

async function putLines(env: Env, key: string, rows: object[]) {
  const body = new Response(new Blob([rows.map((r) => JSON.stringify(r)).join("\n") + "\n"]).stream().pipeThrough(new CompressionStream("gzip")));
  await env.BUCKET.put(key, await body.arrayBuffer(), { httpMetadata: { contentType: "application/gzip" } });
}
async function readLines(bucket: R2Bucket, key: string): Promise<Record<string, any>[]> {
  const o = await bucket.get(key);
  if (!o) return [];
  const text = gunzipSync(new Uint8Array(await o.arrayBuffer())).toString("utf8");
  const out: Record<string, any>[] = [];
  for (const l of text.split("\n")) if (l) try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  return out;
}

async function mark(env: Env, job: string, key: string, status: string, note: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note) VALUES (?, ?, ?, ?, ?)").bind(job, key, status, new Date().toISOString(), note.slice(0, 300)).run();
}

async function collectHour(env: Env, site: BotSite, zoneId: string, hourStart: number) {
  const hour = new Date(hourStart).toISOString().slice(0, 13);
  const day = hour.slice(0, 10);
  const [bots, all] = await Promise.all([readWindow(env, zoneId, hourStart, hourStart + HOUR_MS, true), readWindow(env, zoneId, hourStart, hourStart + HOUR_MS, false)]);
  const crawl = fold(bots.filter((r) => r.dimensions.verifiedBotCategory).map((r) => {
    const d = r.dimensions;
    return { hour, day, host: d.clientRequestHTTPHost, path: d.clientRequestPath, kind: kindOf(d.clientRequestPath), bot_category: d.verifiedBotCategory, bot_name: botName(d.userAgent), country: d.clientCountryName ?? "", status: d.edgeResponseStatus, requests: r.count };
  }));
  const totals = fold(all.map((r) => ({ hour, day, host: r.dimensions.clientRequestHTTPHost, kind: kindOf(r.dimensions.clientRequestPath), audience: r.dimensions.verifiedBotCategory ? "bot" : "other", requests: r.count })));
  const hh = hour.slice(11, 13);
  await putLines(env, `bots/${site.zone}/crawl/${day}/${hh}.ndjson.gz`, crawl);
  await putLines(env, `bots/${site.zone}/totals/${day}/${hh}.ndjson.gz`, totals);
  return crawl.length;
}

async function collectDelivery(env: Env, site: BotSite, day: string) {
  const sql = `SELECT blob1 AS surface, blob2 AS format, blob3 AS tool, blob4 AS locale, blob5 AS bot_name, blob6 AS path, SUM(_sample_interval) AS calls
    FROM ${site.delivery} WHERE toDate(timestamp) = '${day}' GROUP BY surface, format, tool, locale, bot_name, path FORMAT JSON`;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, { method: "POST", headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: sql });
  if (!r.ok) throw new Error(`Analytics Engine: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const b = (await r.json()) as { data?: Record<string, string | number>[] };
  const rows = (b.data ?? []).map((x) => ({ day, surface: x.surface, format: x.format, tool: x.tool, locale: x.locale, bot_name: x.bot_name, path: x.path ?? "", calls: Math.round(Number(x.calls)) }));
  await putLines(env, `bots/${site.zone}/delivery/${day}.ndjson.gz`, rows);
}

/* ---------------------------------------------------------------- a day into D1 */

type Agg = { category: string; requests: number; errors: number; pages: Map<string, number>; kinds: Record<string, number>; statuses: Record<string, number>; countries: Record<string, number>; hosts: Record<string, number> };
const inc = (o: Record<string, number>, k: string, n: number) => { o[k] = (o[k] ?? 0) + n; };

/** One day of a site's crawl rows summed by bot (also used live for today). */
export function aggregateCrawl(rows: Record<string, any>[]) {
  const by = new Map<string, Agg>();
  for (const r of rows) {
    const bot = r.bot_name || "unknown";
    let a = by.get(bot);
    if (!a) by.set(bot, (a = { category: r.bot_category ?? "", requests: 0, errors: 0, pages: new Map(), kinds: {}, statuses: {}, countries: {}, hosts: {} }));
    const n = Number(r.requests) || 0;
    a.requests += n;
    if (Number(r.status) >= 400) a.errors += n;
    if (r.kind !== "asset") a.pages.set(r.path, (a.pages.get(r.path) ?? 0) + n);
    inc(a.kinds, r.kind ?? kindOf(r.path ?? ""), n);
    inc(a.statuses, String(r.status ?? ""), n);
    if (r.country) inc(a.countries, r.country, n);
    if (r.host) inc(a.hosts, r.host, n);
  }
  return [...by.entries()].map(([bot, a]) => ({
    bot, category: a.category, requests: a.requests, errors: a.errors,
    pages: [...a.pages.entries()].sort((x, y) => y[1] - x[1]).slice(0, 200).map(([k, n]) => ({ k, n })),
    kinds: a.kinds, statuses: a.statuses, countries: a.countries, hosts: a.hosts,
  }));
}

export async function dayFiles(bucket: R2Bucket, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (!keys.length) return [];
  const parts = await pool(keys, 6, (key) => readLines(bucket, key));
  return parts.flat();
}

export async function rollupBotDay(env: Env, site: BotSite, day: string) {
  const [rawCrawl, totals] = await Promise.all([
    dayFiles(env.BUCKET, `bots/${site.zone}/crawl/${day}/`),
    dayFiles(env.BUCKET, `bots/${site.zone}/totals/${day}/`),
  ]);
  const crawl = aggregateCrawl(rawCrawl);
  const aiAnswers = crawl.reduce((s, c) => s + (familyOf(c.bot, c.category) === "answers" ? c.requests : 0), 0);
  const kinds: Record<string, { bot: number; other: number }> = {};
  let bot = 0, other = 0;
  for (const t of totals) {
    const n = Number(t.requests) || 0;
    const k = (kinds[t.kind] ??= { bot: 0, other: 0 });
    if (t.audience === "bot") { bot += n; k.bot += n; } else { other += n; k.other += n; }
  }
  const stmts = [env.DB.prepare("DELETE FROM bot_days WHERE site = ? AND day = ?").bind(site.id, day)];
  for (const c of crawl) stmts.push(env.DB.prepare("INSERT INTO bot_days (site, day, bot, category, requests, errors, pages, kinds, statuses, countries, hosts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(site.id, day, c.bot, c.category, c.requests, c.errors, JSON.stringify(c.pages), JSON.stringify(c.kinds), JSON.stringify(c.statuses), JSON.stringify(c.countries), JSON.stringify(c.hosts)));
  if (totals.length || crawl.length) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO traffic_days (site, day, bot_requests, other_requests, kinds, ai_answers) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(site.id, day, bot, other, JSON.stringify(kinds), aiAnswers));
  }
  if (site.delivery) {
    const del = await readLines(env.BUCKET, `bots/${site.zone}/delivery/${day}.ndjson.gz`);
    const m = new Map<string, number>();
    for (const d of del) { const k = [d.surface ?? "", d.format ?? "", d.tool ?? "", d.bot_name ?? ""].join("\u0000"); m.set(k, (m.get(k) ?? 0) + (Number(d.calls) || 0)); }
    stmts.push(env.DB.prepare("DELETE FROM delivery_days WHERE site = ? AND day = ?").bind(site.id, day));
    for (const [k, calls] of m) { const [s, f, t, b] = k.split("\u0000"); stmts.push(env.DB.prepare("INSERT INTO delivery_days (site, day, surface, format, tool, bot, calls) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(site.id, day, s, f, t, b, calls)); }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return crawl.length;
}

/* ---------------------------------------------------------------- the hourly job */

export async function runBots(env: Env, now = Date.now()) {
  if (!env.CF_ANALYTICS_TOKEN) return "CF_ANALYTICS_TOKEN not set";
  const since = botsConfig(env).since ? Date.parse(`${botsConfig(env).since}:00:00Z`) : 0;
  const sites = botSites(env);
  const ids = await zoneIds(env);
  const okRows = (await env.DB.prepare("SELECT key FROM runs WHERE job IN ('bots', 'bots_day', 'bots_delivery') AND status = 'ok' AND ran_at >= ?").bind(new Date(now - 10 * 86400_000).toISOString()).all<{ key: string }>()).results ?? [];
  const ok = new Set(okRows.map((r) => r.key));
  /* Track which (zone|day) windows gained late hours or delivery rows in this run so already-rolled
     days are never re-read from R2 unless new data actually arrived. */
  const dirty = new Set<string>();
  let done = 0, failed = 0;
  const lastClosed = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
  for (let t = lastClosed - (BACKFILL_HOURS - 1) * HOUR_MS; t <= lastClosed && done < WINDOWS_PER_RUN; t += HOUR_MS) {
    if (t < since) continue;
    const hourIso = new Date(t).toISOString().slice(0, 13);
    const hourDay = hourIso.slice(0, 10);
    for (const site of sites) {
      const key = `${site.zone}|${hourIso}`;
      if (ok.has(key) || done >= WINDOWS_PER_RUN) continue;
      try {
        const zoneId = ids.get(site.zone);
        if (!zoneId) throw new Error(`zone ${site.zone} not visible to CF_ANALYTICS_TOKEN`);
        await mark(env, "bots", key, "ok", `${await collectHour(env, site, zoneId, t)} rows`);
        dirty.add(`${site.zone}|${hourDay}`);
        done++;
      } catch (e) { failed++; await mark(env, "bots", key, "failed", String((e as Error).message)); }
    }
  }
  /* Analytics Engine sites: a day once it has been over for 3 hours, a week back. */
  for (const site of sites.filter((s) => s.delivery)) {
    for (let i = 7; i >= 1; i--) {
      const day = utcDay(now - i * 86400_000);
      if (Date.parse(`${day}T00:00:00Z`) < since || Date.parse(`${day}T00:00:00Z`) + 27 * HOUR_MS > now || ok.has(`${site.zone}|${day}|delivery`)) continue;
      try {
        await collectDelivery(env, site, day);
        await mark(env, "bots_delivery", `${site.zone}|${day}|delivery`, "ok", "");
        dirty.add(`${site.zone}|${day}`);
      } catch (e) { failed++; await mark(env, "bots_delivery", `${site.zone}|${day}|delivery`, "failed", String((e as Error).message)); }
    }
  }
  /* Closed days (2 hours of margin) into D1: run once per closed day, or again if late data arrived. */
  let days = 0;
  for (let i = 3; i >= 1; i--) {
    const day = utcDay(now - i * 86400_000);
    if (Date.parse(`${day}T00:00:00Z`) + 26 * HOUR_MS > now || Date.parse(`${day}T00:00:00Z`) + 86400_000 <= since) continue;
    for (const site of sites) {
      const key = `${site.zone}|${day}|day`;
      if (ok.has(key) && !dirty.has(`${site.zone}|${day}`)) continue;
      try { await rollupBotDay(env, site, day); await mark(env, "bots_day", key, "ok", ""); days++; }
      catch (e) { failed++; await mark(env, "bots_day", key, "failed", String((e as Error).message)); }
    }
  }
  return `${done} hours, ${days} days, ${failed} failed`;
}
