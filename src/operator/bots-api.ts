/*
  GET /api/bots?site=<id>&days=N[&bot=<name>][&family=<family>]  the AI and bots screen.
  Closed days from D1 `bot_days` / `traffic_days` / `delivery_days`, today live from its hourly
  files. Families: see bots.ts (answers = an assistant read the page to answer someone).
*/
import type { Env } from "../env";
import { AI_FAMILIES, FAMILIES, aggregateCrawl, botSites, dayFiles, familyOf, missingBotSites, siteById, type BotNotFound, type BotNotFoundDetail, type Family } from "../bots";
import { utcDay } from "../identity";
import { ReadContext } from "../read-context";

type Row = { day: string; notFound: BotNotFoundDetail | null; bot: string; category: string; requests: number; errors: number; pages: { k: string; n: number }[]; kinds: Record<string, number>; statuses: Record<string, number>; countries: Record<string, number> };
type Target = { isAll: true; sites: { id: string; zone: string }[] } | { isAll: false; siteId: string; zone: string };

function siteFilter(target: Target): { clause: string; args: string[] } {
  if (!target.isAll) return { clause: "site = ?", args: [target.siteId] };
  const ids = target.sites.map((s) => s.id);
  if (!ids.length) return { clause: "1 = 0", args: [] };
  return { clause: `site IN (${ids.map(() => "?").join(", ")})`, args: ids };
}

async function liveTodayBots(env: Env, zone: string, today: string, context?: ReadContext): Promise<Row[]> {
  const loader = async () => {
    const files = await dayFiles(env.BUCKET, `bots/${zone}/crawl/${today}/`);
    return aggregateCrawl(files).map((a) => ({ day: today, ...a }));
  };
  if (!context) return loader();
  return context.cached(`bots:${zone}:${today}`, loader, (rows) => rows.length * 1024 + 256);
}

async function rowsFor(env: Env, target: Target, from: string, to: string, botFilter: string | null, withToday: boolean, context?: ReadContext): Promise<Row[]> {
  const sf = siteFilter(target);
  const botClause = botFilter ? " AND bot = ?" : "";
  const args = [...sf.args, from, to, ...(botFilter ? [botFilter] : [])];
  const query = env.DB.prepare(`SELECT day, bot, category, requests, errors, pages, kinds, statuses, countries, not_found FROM bot_days WHERE ${sf.clause} AND day >= ? AND day < ?${botClause}`).bind(...args);
  const res = (await query.all<Record<string, any>>()).results ?? [];
  const rows: Row[] = res.map((r) => ({
    ...r,
    pages: JSON.parse(r.pages || "[]"),
    notFound: r.not_found == null ? null : JSON.parse(r.not_found),
    kinds: JSON.parse(r.kinds || "{}"),
    statuses: JSON.parse(r.statuses || "{}"),
    countries: JSON.parse(r.countries || "{}"),
  }) as Row);
  if (withToday) {
    const today = utcDay(Date.now());
    const zones = target.isAll ? target.sites.map((s) => s.zone) : [target.zone];
    const parts = await Promise.all(zones.map((zone) => liveTodayBots(env, zone, today, context)));
    for (const part of parts) {
      for (const r of part) if (!botFilter || r.bot === botFilter) rows.push(r);
    }
  }
  return rows;
}

async function prevSummaryFor(env: Env, target: Target, from: string, to: string, botFilter: string | null): Promise<{ bot: string; category: string; requests: number }[]> {
  const sf = siteFilter(target);
  const botClause = botFilter ? " AND bot = ?" : "";
  const args = [...sf.args, from, to, ...(botFilter ? [botFilter] : [])];
  const query = env.DB.prepare(`SELECT bot, category, SUM(requests) AS requests FROM bot_days WHERE ${sf.clause} AND day >= ? AND day < ?${botClause} GROUP BY bot, category`).bind(...args);
  return (await query.all<{ bot: string; category: string; requests: number }>()).results ?? [];
}

const add = (o: Record<string, number>, k: string, n: number) => { o[k] = (o[k] ?? 0) + n; };
const top = (m: Record<string, number>, n = 50) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));

export async function botsApi(env: Env, url: URL, days: number, from: string, context?: ReadContext) {
  const allSites = botSites(env);
  const sites = allSites.map((s) => ({ id: s.id, name: s.name, zone: s.zone }));
  const siteParam = url.searchParams.get("site");
  const isAll = siteParam === "*" || siteParam === "all";
  const site = isAll ? null : (siteById(env, siteParam ?? "") ?? allSites[0]);
  if (!isAll && !site) return { sites, site: null };

  const target: Target = isAll
    ? { isAll: true, sites: allSites.map((s) => ({ id: s.id, zone: s.zone })) }
    : { isAll: false, siteId: site!.id, zone: site!.zone };

  const botFilter = url.searchParams.get("bot");
  const famFilter = url.searchParams.get("family") as Family | null;
  const now = Date.now();
  const today = utcDay(now);
  const keepFam = (bot: string, category: string) => !famFilter || familyOf(bot, category) === famFilter;

  const sf = siteFilter(target);
  const prevFrom = utcDay(Date.parse(`${from}T00:00:00Z`) - days * 86400_000);

  const selectedSites = site ? [site] : allSites;
  const sitesByZone = new Map(selectedSites.map(({ id, zone }) => [zone, id]));
  const dayRanges = selectedSites.map(() => "key BETWEEN ? AND ?").join(" OR ");
  const dayBounds = selectedSites.flatMap(({ zone }) => [`${zone}|${prevFrom}|day`, `${zone}|${today}|day`]);
  const [rawRows, rawPrev, traffic, deliveryRes, missingHours, incompleteDays] = await Promise.all([
    rowsFor(env, target, from, today, botFilter, true, context),
    prevSummaryFor(env, target, prevFrom, from, botFilter),
    env.DB.prepare(`SELECT SUM(bot_requests) AS bot, SUM(other_requests) AS other FROM traffic_days WHERE ${sf.clause} AND day >= ?`).bind(...sf.args, from).first<{ bot: number; other: number }>(),
    env.DB.prepare(`SELECT format, tool, SUM(calls) AS calls FROM delivery_days WHERE ${sf.clause} AND day >= ? GROUP BY format, tool ORDER BY calls DESC LIMIT 40`).bind(...sf.args, from).all(),
    missingBotSites(env, selectedSites, now),
    env.DB.prepare(`SELECT key FROM runs WHERE job = 'bots_day' AND status != 'ok' AND (${dayRanges || "1 = 0"})`).bind(...dayBounds).all<{ key: string }>(),
  ]);
  const knownGaps = (incompleteDays.results ?? []).map(({ key }) => {
    const [zone, day] = key.split("|");
    return { site: sitesByZone.get(zone!)!, day: day! };
  });
  const coverage = [...knownGaps.filter((gap) => gap.day >= from), ...missingHours.filter(({ hour }) => hour.slice(0, 10) >= from)
    .map(({ site, hour }) => ({ site: site.id, day: hour.slice(0, 10) }))];

  const rows = rawRows.filter((r) => keepFam(r.bot, r.category));
  const prevRows = rawPrev.filter((r) => keepFam(r.bot, r.category));

  const totals = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
  const previous = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
  const series = new Map<string, Record<string, number>>();
  const bots = new Map<string, { bot: string; family: Family; category: string; requests: number; errors: number; days: Set<string>; pages: Record<string, number> }>();
  const pagesBy: Record<"answers" | "crawl", Record<string, number>> = { answers: {}, crawl: {} };
  const kinds: Record<string, number> = {}, statuses: Record<string, number> = {}, countries: Record<string, number> = {};
  const notFound = new Map<string, BotNotFound>();
  const unindexed = new Set<string>();
  let truncated = false;
  for (const r of prevRows) previous[familyOf(r.bot, r.category)] += r.requests;
  for (const r of rows) {
    const f = familyOf(r.bot, r.category);
    totals[f] += r.requests;
    const s = series.get(r.day) ?? {};
    add(s, f, r.requests);
    series.set(r.day, s);
    const b = bots.get(r.bot) ?? { bot: r.bot, family: f, category: r.category, requests: 0, errors: 0, days: new Set<string>(), pages: {} };
    b.requests += r.requests; b.errors += r.errors; b.days.add(r.day);
    for (const p of r.pages.slice(0, 50)) add(b.pages, p.k, p.n);
    bots.set(r.bot, b);
    if (r.notFound === null && (r.statuses["404"] ?? 0) > 0) unindexed.add(r.day);
    truncated ||= r.notFound?.truncated ?? false;
    for (const entry of r.notFound?.pages ?? []) {
      const key = JSON.stringify([entry.host, entry.path]);
      const total = notFound.get(key) ?? { ...entry, requests: 0 };
      total.requests += entry.requests;
      notFound.set(key, total);
    }
    if (AI_FAMILIES.includes(f)) {
      for (const p of r.pages) add(f === "answers" ? pagesBy.answers : pagesBy.crawl, p.k, p.n);
      for (const [k, n] of Object.entries(r.kinds)) add(kinds, k, n);
      for (const [k, n] of Object.entries(r.statuses)) add(statuses, k, n);
      if (f !== "answers") for (const [k, n] of Object.entries(r.countries)) add(countries, k, n);
    }
  }

  return {
    sites,
    site: isAll ? { id: "*", name: "All products", zone: "*", delivery: false } : { id: site!.id, name: site!.name, zone: site!.zone, delivery: !!site!.delivery },
    from, days,
    totals, coverage, previous: prevRows.length && !knownGaps.length && !coverage.length ? previous : null,
    series: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, live: day === today, ...v })),
    bots: [...bots.values()].sort((a, b) => b.requests - a.requests).slice(0, 80).map((b) => ({ bot: b.bot, family: b.family, category: b.category, requests: b.requests, errors: b.errors, days: b.days.size, pages: top(b.pages, 5) })),
    pages: { answers: top(pagesBy.answers, 100), crawl: top(pagesBy.crawl, 100) },
    kinds: top(kinds, 10), statuses: top(statuses, 12), countries: top(countries, 15),
    notFound: {
      pages: [...notFound.values()].sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host) || a.path.localeCompare(b.path)).slice(0, 50),
      unindexedDays: [...unindexed].sort(),
      truncated,
    },
    traffic: { bot: traffic?.bot ?? 0, other: traffic?.other ?? 0 },
    delivery: deliveryRes.results ?? [],
  };
}

/** Pages an assistant fetched to answer someone, over the closed days of the period (single product). */
export async function aiReads(env: Env, siteId: string, from: string) {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(ai_answers), 0) AS n FROM traffic_days WHERE site = ? AND day >= ?").bind(siteId, from).first<{ n: number }>();
  return row?.n ?? 0;
}
