/*
  Reports and alerts, posted to a webhook. The Worker builds the Slack message itself (`blocks`,
  Block Kit; `text` is the notification preview), so a Slack incoming webhook works as is, and a
  Discord webhook too (append `/slack` to its URL). Any other URL receives the full JSON with the
  numbers (`data`) added, for a workflow tool to use.

  daily   07:05 UTC: yesterday vs the same weekday a week before
  weekly  Monday:    last 7 days vs the 7 before
  monthly the 1st:   last calendar month vs the one before
  alerts  hourly, at most once per alert, product and UTC day (ledger `runs`, job 'alert')
*/
import type { Env } from "./env";
import { utcDay } from "./identity";
import { products } from "./products";
import catalogs from "./catalogs";

type Row = Record<string, any>;
type Sum = { views: number; visitors: number; visits: number; bounces: number; signups: number; revenue: number; ai: number; botViews: number; channels: Map<string, number>; aiSources: Map<string, number>; pages: Map<string, number>; days: number };

function sumRows(rows: Row[], from: string, to: string): Sum {
  const s: Sum = { views: 0, visitors: 0, visits: 0, bounces: 0, signups: 0, revenue: 0, ai: 0, botViews: 0, channels: new Map(), aiSources: new Map(), pages: new Map(), days: 0 };
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of rows) {
    if (r.day < from || r.day > to) continue;
    s.days++;
    s.views += r.views; s.visitors += r.visitors; s.visits += r.visits; s.bounces += r.bounces; s.signups += r.signups; s.revenue += r.revenue_cents; s.botViews += r.bot_views;
    for (const c of JSON.parse(r.channels)) { add(s.channels, c.k, c.visits); if (c.k === "AI") s.ai += c.visits; }
    for (const c of JSON.parse(r.ai_sources)) add(s.aiSources, c.k, c.visits);
    for (const c of JSON.parse(r.pages)) add(s.pages, c.k, c.views);
  }
  return s;
}

const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const money = (cents: number, currency = "eur") => new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
const dayAdd = (d: string, n: number) => utcDay(Date.parse(`${d}T00:00:00Z`) + n * 86400_000);
const num = (n: number) => n.toLocaleString("en-US");

/** ▲ +12 %, ▼ -8 %, or nothing when there is no comparison to make (previous period empty or zero). */
export function delta(cur: number, prev: number, prevHasData: boolean): string {
  if (!prevHasData || prev === 0) return "";
  const p = Math.round(((cur - prev) / prev) * 100);
  return p === 0 ? "· =" : p > 0 ? `▲ +${p}%` : `▼ ${p}%`;
}

/** One block character per day, scaled to the series' own maximum. */
export function spark(values: number[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values, 0);
  if (max === 0) return "▁".repeat(values.length);
  return values.map((v) => (v === 0 ? "▁" : bars.charAt(Math.min(7, Math.max(0, Math.ceil((v / max) * 8) - 1))))).join("");
}

/** `Direct       ████████░░ 82 %` lines, in a code block so the columns line up. */
export function bars(entries: [string, number][], width = 10): string {
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!total) return "";
  const label = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => { const f = Math.max(v > 0 ? 1 : 0, Math.round((v / total) * width)); return `${k.padEnd(label)}  ${"█".repeat(f)}${"░".repeat(width - f)} ${String(Math.round((v / total) * 100)).padStart(3)}%  ${v}`; }).join("\n");
}

export type Period = { kind: "daily" | "weekly" | "monthly"; from: string; to: string; prevFrom: string; prevTo: string; label: string };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: string[] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDay = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return `${DAYS[t.getUTCDay()]}, ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (d: string) => { const t = new Date(`${d}T00:00:00Z`); return `${SHORT[t.getUTCMonth()]} ${t.getUTCDate()}`; };

export function periodFor(kind: Period["kind"], now = Date.now()): Period {
  const today = utcDay(now);
  if (kind === "daily") { const d = dayAdd(today, -1); return { kind, from: d, to: d, prevFrom: dayAdd(d, -7), prevTo: dayAdd(d, -7), label: `Yesterday, ${longDay(d)}` }; }
  if (kind === "weekly") { const to = dayAdd(today, -1), from = dayAdd(today, -7); return { kind, from, to, prevFrom: dayAdd(from, -7), prevTo: dayAdd(to, -7), label: `Week of ${shortDay(from)} to ${shortDay(to)}` }; }
  const first = `${today.slice(0, 7)}-01`;
  const to = dayAdd(first, -1), from = `${to.slice(0, 7)}-01`;
  const prevTo = dayAdd(from, -1), prevFrom = `${prevTo.slice(0, 7)}-01`;
  const m = new Date(`${from}T00:00:00Z`);
  return { kind, from, to, prevFrom, prevTo, label: `${(MONTHS[m.getUTCMonth()] ?? "").replace(/^./, (c) => c.toUpperCase())} ${m.getUTCFullYear()}` };
}

const ICON = { daily: ":sunrise:", weekly: ":calendar:", monthly: ":bar_chart:" };
const KIND = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

export async function buildReport(env: Env, period: Period) {
  const multi = period.kind !== "daily";
  /* A daily "visitor" is a person; over several days the sum counts a returning person once per day, so the headline is visits. */
  const headKey = multi ? "visits" : "visitors";
  const headLabel = multi ? "Visits" : "Visitors";
  const trendFrom = period.kind === "daily" ? dayAdd(period.to, -13) : period.kind === "weekly" ? dayAdd(period.from, -7) : period.from;
  const since = [period.prevFrom, trendFrom, period.from].sort()[0];

  type Card = { id: string; name: string; currency: string; cur: Sum; prev: Sum; trend: number[] };
  const cards: Card[] = [];
  for (const p of products(env.PRODUCTS)) {
    const res = await env.DB.prepare("SELECT * FROM days WHERE product = ? AND host = '*' AND day >= ? AND day <= ?").bind(p.id, since, period.to).all<Row>();
    const rows = res.results ?? [];
    const cur = sumRows(rows, period.from, period.to), prev = sumRows(rows, period.prevFrom, period.prevTo);
    if (!cur.days && !prev.days) continue;
    const byDay = new Map(rows.map((r) => [r.day as string, r[headKey] as number]));
    /* Only days the collection has rows for: before that a zero is "no data", not "no traffic". */
    const trend: number[] = [];
    for (let d = trendFrom; d <= period.to; d = dayAdd(d, 1)) if (byDay.has(d)) trend.push(byDay.get(d) ?? 0);
    cards.push({ id: p.id, name: p.name, currency: p.currency, cur, prev, trend });
  }
  cards.sort((a, b) => b.cur[headKey] - a.cur[headKey]);
  const active = cards.filter((c) => c.cur.views > 0);
  const quiet = cards.filter((c) => c.cur.views === 0);

  /* One currency across the products: format it; several: say so instead of adding euros to dollars. */
  const currencies = new Set(cards.map((c) => c.currency));
  const moneyAll = (cents: number) => (currencies.size > 1 ? "mixed currencies" : money(cents, [...currencies][0]));
  const total = (f: (s: Sum) => number, side: "cur" | "prev") => cards.reduce((s, c) => s + f(c[side]), 0);
  const prevData = cards.some((c) => c.prev.days > 0);
  const kpi = (label: string, f: (s: Sum) => number, fmt: (n: number) => string) => ({ type: "mrkdwn", text: `*${label}*\n${fmt(total(f, "cur"))}  ${total(f, "cur") === 0 ? "" : delta(total(f, "cur"), total(f, "prev"), prevData)}`.trimEnd() });

  const health = await healthIssues(env);
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${period.label}`, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${ICON[period.kind]} *${KIND[period.kind]}*${prevData ? ` · compared with ${period.prevFrom === period.prevTo ? longDay(period.prevFrom) : `${shortDay(period.prevFrom)} → ${shortDay(period.prevTo)}`}` : ""}` }] },
    { type: "section", fields: [kpi(headLabel, (s) => s[headKey], num), kpi("Page views", (s) => s.views, num), kpi("Sign-ups", (s) => s.signups, num), kpi("Revenue", (s) => s.revenue, moneyAll)] },
  ];

  const data: Record<string, unknown>[] = [];
  for (const c of active) {
    const { cur, prev } = c;
    const d = delta(cur[headKey], prev[headKey], prev.days > 0);
    const bounce = cur.visits ? Math.round((cur.bounces / cur.visits) * 100) : 0;
    const conv = cur.visitors ? ((cur.signups / cur.visitors) * 100).toFixed(1) : "0";
    const funnel = cur.signups || cur.revenue ? `\n:bust_in_silhouette: *${cur.signups}* sign-up${cur.signups > 1 ? "s" : ""} (${conv}%)${delta(cur.signups, prev.signups, prev.days > 0) ? ` ${delta(cur.signups, prev.signups, prev.days > 0)}` : ""}${cur.revenue ? `  ·  :moneybag: *${money(cur.revenue, c.currency)}*${delta(cur.revenue, prev.revenue, prev.days > 0) ? ` ${delta(cur.revenue, prev.revenue, prev.days > 0)}` : ""}` : ""}` : "";
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${c.name}*\n${headLabel.toLowerCase()} *${num(cur[headKey])}* ${d}  ·  ${num(cur.views)} pages  ·  bounce ${bounce}%${funnel}${c.trend.length >= 4 ? `\n${spark(c.trend)}  ${c.trend.length} days` : ""}` } });
    const srcs = top(cur.channels, 4);
    const ai = top(cur.aiSources, 3);
    const extra = [srcs.length ? `\`\`\`${bars(srcs)}\`\`\`` : "", ai.length ? `:robot_face: AI: ${ai.map(([k, v]) => `${k} ${v}`).join(" · ")}` : "", multi && cur.pages.size ? `:page_facing_up: ${top(cur.pages, 3).map(([k, v]) => `\`${k}\` ${v}`).join("  ")}` : ""].filter(Boolean);
    if (extra.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: extra.join("\n") } });
    data.push({ product: c.id, current: { ...cur, channels: Object.fromEntries(cur.channels), aiSources: Object.fromEntries(cur.aiSources), pages: Object.fromEntries(top(cur.pages, 10)) }, previous: { visitors: prev.visitors, signups: prev.signups, revenue: prev.revenue, views: prev.views } });
  }
  if (!active.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: "No traffic in this period." } });
  const footer = [quiet.length ? `No traffic: ${quiet.map((c) => c.name).join(", ")}` : "", health.length ? `:warning: ${health.map((h) => h.message).join(" · ")}` : ":white_check_mark: collection and rollups healthy"].filter(Boolean).join("   ·   ");
  blocks.push({ type: "divider" }, { type: "context", elements: [{ type: "mrkdwn", text: footer }] });

  const text = `${period.label}: ${num(total((s) => s[headKey], "cur"))} ${headLabel.toLowerCase()}, ${total((s) => s.signups, "cur")} sign-ups, ${moneyAll(total((s) => s.revenue, "cur"))}`;
  return { event: `report_${period.kind}`, period, text, blocks, data, health, submittedAt: new Date().toISOString() };
}

/** Slack and Discord (via /slack) reject or ignore fields they do not know: send them the message only. */
function forWebhook(url: string, body: unknown): unknown {
  const b = body as { text?: string; blocks?: unknown };
  return /^https:\/\/(hooks\.slack\.com|(?:[a-z]+\.)?discord(?:app)?\.com)\//.test(url) ? { text: b.text, ...(b.blocks ? { blocks: b.blocks } : {}) } : body;
}

async function post(url: string | undefined, env: Env, body: unknown) {
  if (!url) return false;
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(env.WEBHOOK_SECRET ? { authorization: `Bearer ${env.WEBHOOK_SECRET}` } : {}) }, body: JSON.stringify(forWebhook(url, body)), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return Boolean(res?.ok);
}

/** One report now, whatever the day (dashboard button, or `csa report <kind>` through the KV flag). */
export async function sendReportNow(env: Env, kind: Period["kind"], now = Date.now()) {
  return post(env.REPORT_WEBHOOK_URL, env, await buildReport(env, periodFor(kind, now)));
}

export async function sendReports(env: Env, now = Date.now()) {
  const asked = await env.KV.get("report:now");
  if (asked === "daily" || asked === "weekly" || asked === "monthly") {
    await env.KV.delete("report:now");
    await sendReportNow(env, asked, now);
  }
  const d = new Date(now);
  const kinds: Period["kind"][] = ["daily"];
  if (d.getUTCDay() === 1) kinds.push("weekly");
  if (d.getUTCDate() === 1) kinds.push("monthly");
  for (const kind of kinds) {
    const key = `${kind}:${utcDay(now)}`;
    if (await env.DB.prepare("SELECT 1 FROM runs WHERE job = 'report' AND key = ? AND status = 'ok'").bind(key).first()) continue;
    const ok = await post(env.REPORT_WEBHOOK_URL, env, await buildReport(env, periodFor(kind, now)));
    await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at, note) VALUES ('report', ?, ?, ?, ?)").bind(key, ok ? "ok" : "failed", new Date().toISOString(), ok ? null : "webhook unreachable or not configured").run();
  }
}

/* ---------------------------------------------------------------- health */

export type Issue = { id: string; product: string; message: string };

export async function healthIssues(env: Env, now = Date.now()): Promise<Issue[]> {
  const issues: Issue[] = [];
  const since = utcDay(now - 10 * 86400_000);
  const failed = await env.DB.prepare("SELECT job, key, note FROM runs WHERE status != 'ok' AND job IN ('rollup', 'stripe_reconcile', 'report', 'bots_day', 'bots_delivery') AND ran_at >= ?").bind(`${since}T00:00:00Z`).all<{ job: string; key: string; note: string }>();
  for (const r of failed.results ?? []) issues.push({ id: `${r.job}_failed:${r.key}`, product: "*", message: `${r.job} ${r.key} failed (${(r.note ?? "").slice(0, 80)})` });

  /* A rollup that should have run and did not (cron broken). */
  const yesterday2 = utcDay(now - 2 * 86400_000);
  const ok2 = await env.DB.prepare("SELECT 1 FROM runs WHERE job = 'rollup' AND key = ? AND status = 'ok'").bind(yesterday2).first();
  const any = await env.DB.prepare("SELECT 1 FROM days LIMIT 1").first();
  if (any && !ok2) issues.push({ id: `rollup_missing:${yesterday2}`, product: "*", message: `no rollup for ${yesterday2}` });

  for (const p of products(env.PRODUCTS)) {
    /* Silent collection: traffic on most of the last 7 days, none yesterday. */
    const week = await env.DB.prepare("SELECT day, views FROM days WHERE product = ? AND host = '*' AND day >= ? ORDER BY day").bind(p.id, utcDay(now - 8 * 86400_000)).all<{ day: string; views: number }>();
    const rows = week.results ?? [];
    const yesterday = utcDay(now - 86400_000);
    const before = rows.filter((r) => r.day < yesterday);
    const avg = before.length ? before.reduce((s, r) => s + r.views, 0) / before.length : 0;
    const y = rows.find((r) => r.day === yesterday)?.views ?? 0;
    if (before.length >= 4 && avg >= 10 && y === 0) issues.push({ id: `silent:${p.id}:${yesterday}`, product: p.id, message: `${p.name}: no pageview yesterday (average ${Math.round(avg)}/day): tracker or domain broken?` });

    /* Events that are not in the product's catalog. */
    const cat = catalogs[p.id];
    const last = await env.DB.prepare("SELECT custom_events FROM days WHERE product = ? AND host = '*' AND day = ?").bind(p.id, yesterday).first<{ custom_events: string }>();
    if (cat && last) {
      const unknown = (JSON.parse(last.custom_events) as { k: string }[]).map((e) => e.k).filter((k) => !cat.has(k));
      if (unknown.length) issues.push({ id: `unknown_events:${p.id}:${yesterday}`, product: p.id, message: `${p.name}: events outside the catalog: ${unknown.slice(0, 5).join(", ")}` });
    }
  }
  return issues;
}

export async function sendAlerts(env: Env, now = Date.now()) {
  const issues = await healthIssues(env, now);
  for (const i of issues) {
    const key = `${i.id}:${utcDay(now)}`;
    if (await env.DB.prepare("SELECT 1 FROM runs WHERE job = 'alert' AND key = ?").bind(key).first()) continue;
    const ok = await post(env.ALERT_WEBHOOK_URL, env, { event: "analytics_alert", product: i.product, text: `:rotating_light: Analytics · ${i.message}`, issue: i, submittedAt: new Date().toISOString() });
    if (ok) await env.DB.prepare("INSERT OR REPLACE INTO runs (job, key, status, ran_at) VALUES ('alert', ?, 'ok', ?)").bind(key, new Date().toISOString()).run();
  }
  return issues;
}
