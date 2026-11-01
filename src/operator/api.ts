/*
  The dashboard's read API, behind a passkey session (auth.ts). Read only: nothing here writes
  to a product or to Stripe. Numbers over several days sum daily rows; visitors summed over days
  are "visitor-days" (a level-0 visitor gets a new hash every day), labelled as such in the UI.
*/
import type { Env } from "../env";
import { utcDay } from "../identity";
import { products } from "../products";
import { liveRows } from "../rollup";
import { replayEvents } from "../replay";
import { buildReport, healthIssues, periodFor, sendReportNow } from "../report";
import { verifyOperator, csrfToken, csrfOk } from "./auth";
import { reconcileStripe } from "../stripe";
import { FIRST_TOUCH, filteredDays, parseFilters } from "../explore";
import { computeProductFunnels, personActivity } from "../journeys";
import { funnels } from "../funnels";
import { aiEnabled, aiFilters } from "../ai-filter";
import catalogs, { activations } from "../catalogs";
import { botsApi } from "./bots-api";
import { ReadContext } from "../read-context";
import { peopleOrder } from "./people-sort";
import { readBoundedText } from "../http-security";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });

async function today(env: Env, context: ReadContext) {
  return context.cached(`live:${utcDay(Date.now())}`, () => liveRows(env, Date.now(), context), (rows) => JSON.stringify(rows).length * 2 + 1024);
}

type Top = { k: string; views?: number; visits?: number; visitors?: number; count?: number; users?: number };
function mergeTops(lists: Top[][], by: keyof Top, n = 50): Top[] {
  const m = new Map<string, Top>();
  for (const list of lists) for (const t of list) {
    const cur = m.get(t.k) ?? { k: t.k };
    for (const f of ["views", "visits", "visitors", "count", "users"] as const) if (typeof t[f] === "number") cur[f] = (cur[f] ?? 0) + (t[f] as number);
    m.set(t.k, cur);
  }
  return [...m.values()].sort((a, b) => ((b[by] as number) ?? 0) - ((a[by] as number) ?? 0)).slice(0, n);
}

const TOP_FIELDS: [string, keyof Top][] = [["pages", "views"], ["entries", "visits"], ["referrers", "visits"], ["channels", "visits"], ["ai_sources", "visits"], ["utm_sources", "visits"], ["utm_campaigns", "visits"], ["countries", "visitors"], ["cities", "visitors"], ["devices", "visitors"], ["browsers", "visitors"], ["os", "visitors"], ["langs", "visitors"], ["custom_events", "count"]];
const NUMS = ["views", "visitors", "visits", "bounces", "engaged_ms", "returning_visitors", "signups", "events", "bot_views", "revenue_cents"] as const;
const SUM_NUMS_SQL = NUMS.map((k) => `COALESCE(SUM(${k}), 0) AS ${k}`).join(", ");

function appendTodayRow(rows: Record<string, any>[], todayRows: Awaited<ReturnType<typeof today>>, product: string, host: string, fullTops: boolean) {
  const todayRow = todayRows.find((r) => r.product === product && r.host === host);
  if (!todayRow) return rows;
  const t: Record<string, any> = { ...todayRow, returning_visitors: todayRow.returning, revenue_cents: 0, live: true };
  if (fullTops) {
    for (const [f] of TOP_FIELDS) t[f] = JSON.stringify((todayRow as any)[f]);
    t.vitals = JSON.stringify(todayRow.vitals);
  } else {
    t.channels = JSON.stringify(todayRow.channels);
  }
  t.hourly = JSON.stringify(todayRow.hourly);
  rows.push(t);
  return rows;
}

async function productDays(env: Env, product: string, host: string, from: string, context: ReadContext) {
  const [res, todayRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM days WHERE product = ? AND host = ? AND day >= ? ORDER BY day").bind(product, host, from).all<Record<string, any>>(),
    today(env, context),
  ]);
  return appendTodayRow(res.results ?? [], todayRows, product, host, true);
}

/* Totals of the same length just before the period, summed inside SQLite. */
async function previousTotals(env: Env, product: string, host: string, from: string, days: number) {
  const start = utcDay(Date.parse(`${from}T00:00:00Z`) - days * 86400_000);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n_days, ${SUM_NUMS_SQL} FROM days WHERE product = ? AND host = ? AND day >= ? AND day < ?`).bind(product, host, start, from).first<Record<string, number>>();
  if (!row || !row.n_days) return null;
  return Object.fromEntries(NUMS.map((k) => [k, row[k] ?? 0]));
}

/** Sample-weighted average of daily p75 Web Vitals across the period (instead of worst-day Math.max). */
function mergeVitals(rows: Record<string, any>[]) {
  let lcpSum = 0, lcpW = 0, inpSum = 0, inpW = 0, clsSum = 0, clsW = 0;
  for (const r of rows) {
    const v = r.vitals ? JSON.parse(r.vitals) : null;
    if (!v || !(v.n || v.n_lcp || v.n_inp || v.n_cls)) continue;
    const wl = v.n_lcp ?? v.n ?? 0;
    const wi = v.n_inp ?? (v.inp_p75 != null ? (v.n ?? 1) : 0);
    const wc = v.n_cls ?? v.n ?? 0;
    if (typeof v.lcp_p75 === "number" && wl > 0) { lcpSum += v.lcp_p75 * wl; lcpW += wl; }
    if (typeof v.inp_p75 === "number" && wi > 0) { inpSum += v.inp_p75 * wi; inpW += wi; }
    if (typeof v.cls_p75 === "number" && wc > 0) { clsSum += v.cls_p75 * wc; clsW += wc; }
  }
  if (!lcpW && !inpW && !clsW) return null;
  return {
    lcp_p75: lcpW ? Math.round(lcpSum / lcpW) : null,
    inp_p75: inpW ? Math.round(inpSum / inpW) : null,
    cls_p75: clsW ? Number((clsSum / clsW).toFixed(3)) : null,
  };
}

/** Page views and visits by UTC hour, summed over the rows (the time-of-day panel; today's curve). */
function hoursOf(rows: Record<string, any>[]) {
  const views = new Array<number>(24).fill(0), visits = new Array<number>(24).fill(0);
  for (const r of rows) {
    const h = r.hourly ? JSON.parse(r.hourly) : null;
    if (!h) continue;
    for (let i = 0; i < 24; i++) { views[i]! += h.views?.[i] ?? 0; visits[i]! += h.visits?.[i] ?? 0; }
  }
  return { views, visits, known: rows.some((r) => r.hourly) };
}

/** Where the money came from: payments of the period by the payer's first touch, by item, new or repeat. */
async function revenueBreakdown(env: Env, product: string, from: string) {
  const rows = (await env.DB.prepare(`SELECT p.amount_cents AS c, p.item, p.kind, p.user_id, p.email, p.attribution, p.created_at,
      (SELECT MIN(q.created_at) FROM payments q WHERE q.product = p.product AND q.livemode = 1 AND q.amount_cents > 0 AND COALESCE(q.user_id, q.email) = COALESCE(p.user_id, p.email)) AS first_paid
      FROM payments p WHERE p.product = ? AND p.created_at >= ? AND p.livemode = 1`).bind(product, `${from}T00:00:00Z`).all<Record<string, any>>()).results ?? [];
  const by = (key: (r: Record<string, any>, a: Record<string, any>) => string | null | undefined) => {
    const m = new Map<string, { k: string; count: number; users: number }>();
    for (const r of rows) {
      const a = r.attribution ? JSON.parse(r.attribution) : {};
      const k = key(r, a) || "Unknown";
      const cur = m.get(k) ?? { k, count: 0, users: 0 };
      cur.count += r.c; cur.users += 1;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  };
  return {
    total: rows.reduce((s, r) => s + r.c, 0),
    payments: rows.length,
    channels: by((_, a) => a.channel),
    ai_sources: by((_, a) => a.ai_source).filter((x) => x.k !== "Unknown"),
    countries: by((_, a) => a.country),
    entries: by((_, a) => a.entry_path),
    items: by((r) => r.kind === "refund" ? "refunds" : r.item),
    kinds: by((r) => r.kind === "refund" ? "Refund" : r.created_at === r.first_paid ? "New customer" : "Repeat"),
    customers: by((r) => r.email ?? r.user_id).slice(0, 20),
  };
}

const point = (r: Record<string, any>) => ({ day: r.day, live: Boolean(r.live), ...Object.fromEntries(NUMS.map((k) => [k, r[k] ?? 0])) });

export async function operatorApi(request: Request, env: Env): Promise<Response> {
  const operator = await verifyOperator(request, env);
  if (!operator) return json({ error: { code: "unauthenticated", message: "Sign in with your passkey." } }, 401);
  if (request.method !== "GET" && !(await csrfOk(request, env, operator))) return json({ error: { code: "forbidden" } }, 403);
  const url = new URL(request.url);
  const path = url.pathname;
  const started = performance.now();
  const context = new ReadContext(env, request.headers.get("x-csa-refresh") === "1");
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 400);
  const from = utcDay(Date.now() - (days - 1) * 86400_000);
  let m: RegExpExecArray | null;
  try {
    let res: Response;
    if (path === "/api/me") res = json({ csrf: await csrfToken(env, operator), operator: env.OPERATOR_NAME, ai: aiEnabled(env), products: products(env.PRODUCTS).map((p) => ({ id: p.id, name: p.name, domain: p.domain })) });
    else if (path === "/api/overview") {
      const prods = products(env.PRODUCTS);
      if (!prods.length) res = json({ from, days, products: [] });
      else {
        const ids = prods.map((p) => p.id);
        const inClause = ids.map(() => "?").join(", ");
        const prevStart = utcDay(Date.parse(`${from}T00:00:00Z`) - days * 86400_000);
        const [batchRes, todayRows] = await Promise.all([
          env.DB.batch([
            env.DB.prepare(`SELECT product, day, ${NUMS.join(", ")}, channels, hourly FROM days WHERE product IN (${inClause}) AND host = '*' AND day >= ? ORDER BY product, day`).bind(...ids, from),
            env.DB.prepare(`SELECT product, COUNT(*) AS n_days, ${SUM_NUMS_SQL} FROM days WHERE product IN (${inClause}) AND host = '*' AND day >= ? AND day < ? GROUP BY product`).bind(...ids, prevStart, from),
            env.DB.prepare(`SELECT site, COALESCE(SUM(ai_answers), 0) AS n FROM traffic_days WHERE site IN (${inClause}) AND day >= ? GROUP BY site`).bind(...ids, from),
          ]),
          today(env, context),
        ]);
        const curByProd = new Map<string, Record<string, any>[]>(ids.map((id) => [id, []]));
        for (const r of (batchRes[0]?.results ?? []) as Record<string, any>[]) curByProd.get(r.product)?.push(r);
        const prevByProd = new Map<string, Record<string, number>>();
        for (const r of (batchRes[1]?.results ?? []) as Record<string, number & string>[]) {
          if (r.n_days) prevByProd.set(String(r.product), Object.fromEntries(NUMS.map((k) => [k, Number(r[k] ?? 0)])));
        }
        const aiByProd = new Map<string, number>();
        for (const r of (batchRes[2]?.results ?? []) as { site: string; n: number }[]) aiByProd.set(r.site, r.n ?? 0);

        const out = prods.map((p) => {
          const rows = appendTodayRow(curByProd.get(p.id) ?? [], todayRows, p.id, "*", false);
          const totals = Object.fromEntries(NUMS.map((k) => [k, rows.reduce((s, r) => s + (r[k] ?? 0), 0)]));
          const channels = mergeTops(rows.map((r) => JSON.parse(r.channels ?? "[]")), "visits", 8);
          return {
            id: p.id, name: p.name, domain: p.domain,
            totals,
            previous: prevByProd.get(p.id) ?? null,
            channels,
            hours: hoursOf(rows),
            series: rows.map(point),
            aiReads: aiByProd.get(p.id) ?? 0,
          };
        });
        res = json({ from, days, products: out });
      }
    } else if ((m = /^\/api\/product\/([a-z0-9-]+)$/.exec(path))) {
      const product = m[1]!;
      const host = url.searchParams.get("host") ?? "*";
      const filters = parseFilters(url.searchParams);
      /* Source filters also cut revenue and people, through each person's first touch. */
      const ftFilters = filters.filter((f) => FIRST_TOUCH[f.dim] && (f.op ?? "is") === "is");
      const peopleWhere = ftFilters.map((f) => `AND json_extract(first_touch, '${FIRST_TOUCH[f.dim]}') = ?`).join(" ");
      const peopleArgs = ftFilters.map((f) => f.value);
      let rows: Record<string, any>[];
      let previous: Record<string, number> | null;
      if (filters.length) {
        const prevFrom = utcDay(Date.parse(`${from}T00:00:00Z`) - days * 86400_000);
        const all = await filteredDays(env, product, host, days <= 90 ? prevFrom : from, days <= 90 ? days * 2 : days, filters, context);
        rows = all.filter((row) => row.day >= from);
        const prev = all.filter((row) => row.day < from);
        previous = prev.length ? Object.fromEntries(NUMS.map((k) => [k, prev.reduce((s, r) => s + (r[k] ?? 0), 0)])) : null;
        if (host === "*" && ftFilters.length === filters.length) {
          const pay = (await env.DB.prepare(`SELECT substr(created_at, 1, 10) AS day, SUM(amount_cents) AS c FROM payments WHERE product = ? AND livemode = 1 AND created_at >= ? ${ftFilters.map((f) => `AND json_extract(attribution, '${FIRST_TOUCH[f.dim]}') = ?`).join(" ")} GROUP BY day`)
            .bind(product, `${from}T00:00:00Z`, ...peopleArgs).all<{ day: string; c: number }>()).results ?? [];
          for (const p of pay) { const r = rows.find((x) => x.day === p.day); if (r) r.revenue_cents = p.c; else rows.push({ day: p.day, revenue_cents: p.c }); }
          rows.sort((a, b) => a.day.localeCompare(b.day));
        }
      } else {
        [rows, previous] = await Promise.all([productDays(env, product, host, from, context), previousTotals(env, product, host, from, days)]);
      }
      const totals = Object.fromEntries(NUMS.map((k) => [k, rows.reduce((s, r) => s + (r[k] ?? 0), 0)]));
      const tops = Object.fromEntries(TOP_FIELDS.map(([f, by]) => [f, mergeTops(rows.map((r) => JSON.parse(r[f] ?? "[]")), by)]));
      const hosts = (await env.DB.prepare("SELECT DISTINCT host FROM days WHERE product = ? AND day >= ?").bind(product, from).all<{ host: string }>()).results?.map((r) => r.host) ?? [];
      const peopleOk = ftFilters.length === filters.length;
      const signupsByChannel = peopleOk ? (await env.DB.prepare(`SELECT COALESCE(json_extract(first_touch, '$.channel'), 'Unknown') AS k, COUNT(*) AS n, SUM(CASE WHEN ltv_cents > 0 THEN 1 ELSE 0 END) AS paid, SUM(ltv_cents) AS ltv FROM people WHERE product = ? AND created_at >= ? ${peopleWhere} GROUP BY k ORDER BY n DESC`).bind(product, from, ...peopleArgs).all()).results : null;
      const attribution = peopleOk ? (await env.DB.prepare(`SELECT COALESCE(attribution_method, 'none') AS k, COUNT(*) AS n FROM people WHERE product = ? AND created_at >= ? ${peopleWhere} GROUP BY k`).bind(product, from, ...peopleArgs).all()).results : [];
      res = json({ product, host, hosts, from, days, filters, totals, previous, tops, signupsByChannel, attribution, hours: hoursOf(rows),
        revenue: host === "*" && !filters.length ? await revenueBreakdown(env, product, from) : null,
        vitals: mergeVitals(rows),
        series: rows.map(point) });
    } else if (path === "/api/funnels") {
      /* Every funnel of the code, computed on the period via constant-memory day streaming. */
      const only = url.searchParams.get("product") ?? "";
      const span = Math.min(days, 90);
      const chosen = funnels.filter((x) => !only || x.product === only);
      res = json({ days: span, funnels: await computeProductFunnels(env, chosen, span, context) });
    } else if (path === "/api/ai/filter" && request.method === "POST") {
      const rawBody = await readBoundedText(request, 16 * 1024);
      if (rawBody === null) return json({ error: { code: "payload_too_large" } }, 413);
      let b: { product?: string; text?: string } = {};
      try { b = JSON.parse(rawBody || "{}"); } catch {}
      const product = b.product ?? "";
      if (!b.text?.trim() || b.text.length > 500 || !products(env.PRODUCTS).some((p) => p.id === product)) res = json({ error: { code: "invalid", message: "Describe the traffic you want to see." } }, 400);
      else {
        const rows = (await env.DB.prepare("SELECT * FROM days WHERE product = ? AND host = '*' AND day >= ?").bind(product, utcDay(Date.now() - 30 * 86400_000)).all<Record<string, any>>()).results ?? [];
        const keys = (f: string, by: keyof Top, n = 40) => mergeTops(rows.map((r) => JSON.parse(r[f] ?? "[]")), by, n).map((t) => t.k);
        const values: Record<string, string[]> = {
          channel: keys("channels", "visits"), referrer: keys("referrers", "visits"), ai: keys("ai_sources", "visits"), utm_source: keys("utm_sources", "visits"),
          utm_campaign: keys("utm_campaigns", "visits"), entry: keys("entries", "visits"), page: keys("pages", "views", 60), country: keys("countries", "visitors"),
          city: keys("cities", "visitors", 20), device: keys("devices", "visitors"), browser: keys("browsers", "visitors"), os: keys("os", "visitors"),
          lang: keys("langs", "visitors"), event: [...new Set([...keys("custom_events", "count"), ...(catalogs[product] ? [...catalogs[product]] : [])])],
        };
        res = json({ filters: await aiFilters(env, b.text.slice(0, 500), values) });
      }
    } else if (path === "/api/options") {
      const product = url.searchParams.get("product") ?? "";
      const rows = (await env.DB.prepare("SELECT pages, custom_events FROM days WHERE product = ? AND host = '*' AND day >= ?").bind(product, from).all<{ pages: string; custom_events: string }>()).results ?? [];
      const pages = mergeTops(rows.map((r) => JSON.parse(r.pages ?? "[]")), "views", 200).map((t) => t.k);
      const seen = mergeTops(rows.map((r) => JSON.parse(r.custom_events ?? "[]")), "count", 200).map((t) => t.k);
      const events = [...new Set([...seen, ...(catalogs[product] ? [...catalogs[product]] : [])])];
      res = json({ pages, events, activation: activations[product] ?? null });
    } else if ((m = /^\/api\/activity\/([a-z0-9-]+)\/(.+)$/.exec(path))) {
      res = json({ days: Math.min(days, 90), events: await personActivity(env, m[1]!, decodeURIComponent(m[2]!), Math.min(days, 90), context) });
    } else if (path === "/api/stripe/sync" && request.method === "POST") {
      res = json({ results: await reconcileStripe(env) });
    } else if (path === "/api/people") {
      const product = url.searchParams.get("product") ?? "";
      const q = `%${(url.searchParams.get("q") ?? "").toLowerCase()}%`;
      const rows = await env.DB.prepare(`SELECT product, user_id, email, name, plan, created_at, last_seen_at, ltv_cents, currency, attribution_method,
          json_extract(first_touch, '$.channel') AS channel, json_extract(first_touch, '$.ai_source') AS ai_source, json_extract(first_touch, '$.referrer_host') AS referrer_host,
          json_extract(first_touch, '$.country') AS country, (SELECT COUNT(*) FROM replay_sessions r WHERE r.product = people.product AND r.user_id = people.user_id) AS replays
          FROM people WHERE (?1 = '' OR product = ?1) AND (lower(COALESCE(email, '')) LIKE ?2 OR lower(COALESCE(name, '')) LIKE ?2 OR user_id LIKE ?2)
          ORDER BY ${peopleOrder(url.searchParams.get("sort"))} LIMIT 200`).bind(product, q).all();
      res = json({ people: rows.results ?? [] });
    } else if ((m = /^\/api\/person\/([a-z0-9-]+)\/(.+)$/.exec(path))) {
      const [p, u] = [m[1]!, decodeURIComponent(m[2]!)];
      const person = await env.DB.prepare("SELECT * FROM people WHERE product = ? AND user_id = ?").bind(p, u).first();
      const payments = (await env.DB.prepare("SELECT * FROM payments WHERE product = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100").bind(p, u).all()).results;
      const replays = (await env.DB.prepare("SELECT * FROM replay_sessions WHERE product = ? AND user_id = ? ORDER BY started_at DESC LIMIT 50").bind(p, u).all()).results;
      const identities = (await env.DB.prepare("SELECT kind, method, at FROM identities WHERE product = ? AND user_id = ?").bind(p, u).all()).results;
      res = person ? json({ person, payments, replays, identities }) : json({ error: { code: "not_found" } }, 404);
    } else if (path === "/api/replays") {
      const product = url.searchParams.get("product") ?? "";
      const rows = await env.DB.prepare(`SELECT r.*, p.email FROM replay_sessions r LEFT JOIN people p ON p.product = r.product AND p.user_id = r.user_id
          WHERE (?1 = '' OR r.product = ?1) AND r.day >= ?2 ORDER BY r.started_at DESC LIMIT 200`).bind(product, from).all();
      res = json({ replays: rows.results ?? [] });
    } else if ((m = /^\/api\/replay\/(rs_[A-Za-z0-9]+)$/.exec(path))) {
      const row = await env.DB.prepare("SELECT product, day FROM replay_sessions WHERE id = ?").bind(m[1]).first<{ product: string; day: string }>();
      res = row ? json({ events: await replayEvents(env, row.product, row.day, m[1]!) }) : json({ error: { code: "not_found" } }, 404);
    } else if (path === "/api/payments") {
      const rows = await env.DB.prepare("SELECT * FROM payments WHERE created_at >= ? ORDER BY created_at DESC LIMIT 300").bind(`${from}T00:00:00Z`).all();
      res = json({ payments: rows.results ?? [] });
    } else if ((m = /^\/api\/reports\/(daily|weekly|monthly)$/.exec(path))) {
      const kind = m[1] as "daily" | "weekly" | "monthly";
      res = request.method === "POST" ? json({ sent: await sendReportNow(env, kind) }) : json(await buildReport(env, periodFor(kind)));
    } else if (path === "/api/bots") {
      res = json(await botsApi(env, url, days, from, context));
    } else if (path === "/api/health") {
      const runs = (await env.DB.prepare("SELECT * FROM runs WHERE job != 'alert' ORDER BY ran_at DESC LIMIT 60").all()).results;
      res = json({ issues: await healthIssues(env), runs });
    } else res = json({ error: { code: "not_found" } }, 404);
    if (operator.renewed) res.headers.append("set-cookie", operator.renewed);
    res.headers.set("server-timing", `read;dur=${(performance.now() - started).toFixed(1)}`);
    res.headers.set("x-csa-data-max-age", "120");
    return res;
  } catch (e) {
    console.error(JSON.stringify({ event: "operator_api_failed", path, reason: String((e as Error)?.message ?? e).slice(0, 200) }));
    return json({ error: { code: "internal" } }, 500);
  }
}
