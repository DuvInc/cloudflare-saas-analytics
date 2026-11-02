#!/usr/bin/env node
/**
 * csa: Cloudflare SaaS Analytics for you and for your agents. Every query runs locally in DuckDB: free,
 * whatever the SQL. Read SCHEMA.md before stating a number.
 *
 *   csa sync [--days 90] [--bots]       pull compacted days (R2 -> .archive/*.parquet) and the D1 tables
 *   csa overview [--days 30]            every product: visitors, visits, signups, revenue, AI share
 *   csa channels --product P [--days]   visits, signups and revenue by channel and AI assistant
 *   csa pages --product P [--days]      top pages and entry pages
 *   csa funnel --product P [--days]     visitors -> signups -> activated -> paid, by channel
 *   csa user <email|user_id>            one person: origin, events, payments, replays
 *   csa replays [--product P] [--days 7]   recorded sessions (signed-in users), worst first
 *   csa replay <rs_id> --out /absolute/private/dir   validated replay and timeline (local sensitive files)
 *   csa today [--product P]             live numbers from today's raw files (not yet rolled up)
 *   csa health                          ledger and alerts
 *   csa sql "<DuckDB SQL>" [--live]     ad hoc; views below. --live adds today's raw events to `events`
 *   csa kill <product|*> [--off]        stop collection now (KV switch, ~60 s), --off turns it back on
 *   csa report [daily|weekly|monthly]   send that report to your webhook at the next hourly run (:17)
 *   csa enroll [--minutes 30]           one-time link to register a passkey on the dashboard
 *
 * Views: events (one row per event, every column of SCHEMA.md), days, people, identities,
 * payments, replay_sessions, runs, traffic_days, delivery_days, and after `sync --bots`: ai_crawl,
 * traffic_totals. Output: Markdown tables, provenance line first.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { connectArchive, rows, table } from "./archive.mjs";
import { R2Reader } from "./r2-read.mjs";
import { syncCompactedDay } from "./compact-sync.mjs";
import { deployment } from "./config.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/* The event columns and their types, from the stream's schema: auto-detection guessed UUID for the
   user ids of products that use UUIDs (some products) and VARCHAR for the others, and the mix broke every query. */
const DUCK = { int64: "BIGINT", string: "VARCHAR", bool: "BOOLEAN", float64: "DOUBLE" };
const COLUMNS = `{${[...JSON.parse(readFileSync(new URL("../schema/stream.json", import.meta.url), "utf8")).fields.map((f) => `${f.name}: '${DUCK[f.type]}'`)].join(", ")}}`;
const CACHE = path.join(ROOT, ".archive");
const WRANGLER = path.join(ROOT, "node_modules", ".bin", "wrangler");
const { database: DATABASE, bucket: BUCKET, dashboard: DASHBOARD } = deployment();
const TABLES = ["days", "people", "identities", "payments", "replay_sessions", "runs", "traffic_days", "delivery_days"];

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);
const DAYS = Number(flag("days") ?? (cmd === "replays" ? 7 : cmd === "sync" ? 90 : 30));
const PRODUCT = flag("product");
let since;
function d1(sql) {
  const out = execFileSync(WRANGLER, ["d1", "execute", DATABASE, "--remote", "--json", "--command", sql], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out)[0]?.results ?? [];
}
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function duck({ live = false, remote = false } = {}) {
  return connectArchive({ root: ROOT, cache: CACHE, live, remote });
}
function provenance(extra = "") {
  const stamp = path.join(CACHE, "synced_at");
  const synced = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "never (run csa sync)";
  console.log(`> Period ${since} to today (${DAYS} days, UTC)${PRODUCT ? `, product ${PRODUCT}` : ""}. Local sync: ${synced}. Closed days only, except \`today\` and \`--live\`.${extra ? ` ${extra}` : ""}\n`);
}

async function sync() {
  mkdirSync(path.join(CACHE, "events"), { recursive: true });
  mkdirSync(path.join(CACHE, "d1"), { recursive: true });
  for (const t of TABLES) writeFileSync(path.join(CACHE, "d1", `${t}.json`), JSON.stringify(d1(`SELECT * FROM ${t}${t === "runs" ? " WHERE job != 'alert'" : ""}`)));
  const ledger = d1(`SELECT key, files, ran_at FROM runs WHERE job = 'rollup' AND status = 'ok' AND key >= '${since}' ORDER BY key`);
  const db = await duck({ remote: true });
  const reader = new R2Reader(ROOT);
  let pulled = 0;
  for (const r of ledger) {
    const out = path.join(CACHE, "events", `${r.key}.parquet`);
    const stamp = `${out}.ran_at`;
    if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === r.ran_at) continue;
    const files = JSON.parse(r.files);
    if (!files.length) continue;
    await syncCompactedDay(db, reader, files, out, COLUMNS);
    writeFileSync(stamp, r.ran_at);
    pulled++;
  }
  if (has("bots")) {
    for (const kind of ["crawl", "totals"]) mkdirSync(path.join(CACHE, "bots", kind), { recursive: true });
    const recent = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    for (let t = Date.parse(`${since}T00:00:00Z`); t < Date.now() - 86400_000; t += 86400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      for (const kind of ["crawl", "totals"]) {
        const out = path.join(CACHE, "bots", kind, `${day}.parquet`);
        if (existsSync(out) && day < recent) continue;
        const n = Number((await db.runAndReadAll(`SELECT COUNT(*) AS n FROM glob('r2://${BUCKET}/bots/*/${kind}/${day}/*')`)).getRowObjects()[0].n);
        if (!n) continue;
        await db.run(`COPY (SELECT regexp_extract(filename, 'bots/([^/]+)/', 1) AS zone, * EXCLUDE (filename) FROM read_json('r2://${BUCKET}/bots/*/${kind}/${day}/*', format = 'newline_delimited', compression = 'gzip', filename = true, union_by_name = true)) TO ${sq(out)} (FORMAT parquet, COMPRESSION zstd)`);
      }
    }
  }
  writeFileSync(path.join(CACHE, "synced_at"), new Date().toISOString());
  console.log(`Sync: ${ledger.length} closed day(s) in the period, ${pulled} downloaded, D1 tables copied${has("bots") ? ", bots up to date" : ""}.`);
}

const pf = PRODUCT ? `AND product = ${sq(PRODUCT)}` : "";

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(readFileSync(import.meta.filename, "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, "")); return; }
  if (!Number.isInteger(DAYS) || DAYS < 1 || DAYS > 400) throw new Error("--days must be an integer between 1 and 400.");
  since = new Date(Date.now() - (DAYS - 1) * 86400_000).toISOString().slice(0, 10);
  if (PRODUCT && !/^[a-z][a-z0-9-]{0,63}$/.test(PRODUCT)) throw new Error("Invalid product.");
  if (cmd === "health") {
    console.log(`> Live health, D1, ${new Date().toISOString()}.`);
    table(d1("SELECT job, key, status, ran_at, note FROM runs WHERE job != 'alert' ORDER BY ran_at DESC LIMIT 20"));
    return;
  }
  if (cmd === "sync") return sync();
  if (cmd === "replay") {
    const id = argv[1];
    const out = flag("out");
    if (!/^rs_[A-Za-z0-9]{16,32}$/.test(id ?? "") || !out || !path.isAbsolute(out)) throw new Error("csa replay <rs_id> --out /absolute/private/dir [--dry-run]");
    if (!path.relative(ROOT, out).startsWith("..")) throw new Error("Sensitive replay output must be outside this repository.");
    const meta = d1(`SELECT id, product, day FROM replay_sessions WHERE id = ${sq(id)}`)[0];
    if (!meta) throw new Error("Unknown (or expired) session.");
    if (has("dry-run")) { console.log(`1 replay: CREATE raw JSON + resumable chunk cache in ${out}; no download yet.`); return; }
    const { R2Reader } = await import("./r2-read.mjs");
    const { readReplay, writePrivate } = await import("./replay-read.mjs");
    const { events } = await readReplay(new R2Reader(ROOT), meta, out);
    writePrivate(path.join(out, `${id}.json`), JSON.stringify(events));
    console.log(`${events.length} validated rrweb events → ${out}/${id}.json. Sensitive content: replays show what your users saw. Play it in the dashboard, or feed it to your own tooling.`);
    return;
  }
  if (cmd === "kill") {
    const target = argv[1];
    if (!target) throw new Error("csa kill <product|*> [--off]");
    const args = has("off") ? ["kv", "key", "delete", `kill:${target}`] : ["kv", "key", "put", `kill:${target}`, "1"];
    execFileSync(WRANGLER, [...args, "--binding", "KV", "--remote"], { cwd: ROOT, stdio: "inherit" });
    console.log(has("off") ? `Collection restored for ${target} (within 60 s).` : `Collection stopped for ${target} (within 60 s). Restore: csa kill ${target} --off`);
    return;
  }
  if (cmd === "report") {
    const kind = argv[1] ?? "daily";
    if (!["daily", "weekly", "monthly"].includes(kind)) throw new Error("csa report daily|weekly|monthly");
    execFileSync(WRANGLER, ["kv", "key", "put", "report:now", kind, "--binding", "KV", "--remote"], { cwd: ROOT, stdio: "ignore" });
    console.log(`${kind} report requested: the hourly cron (at :17) posts it to your webhook. Immediate: the button on the dashboard's Health screen.`);
    return;
  }
  if (cmd === "enroll") {
    const code = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(code).digest("hex");
    d1(`INSERT INTO operator_enrollments (code_hash, created_at, expires_at, created_by) VALUES ('${hash}', '${new Date().toISOString()}', ${Date.now() + Number(flag("minutes") ?? 30) * 60_000}, 'cli')`);
    console.log(`Link valid for ${flag("minutes") ?? 30} minutes, open it on the device to register:\n${DASHBOARD || "<your dashboard URL>"}/?enroll=${code}`);
    return;
  }
  const db = await duck({ live: has("live") || cmd === "today" });
  if (cmd === "sql") { provenance(); table(await rows(db, argv[1])); return; }
  if (cmd === "overview") {
    provenance("Visitors = sum of daily visitors (an anonymous visitor gets a new fingerprint every day).");
    table(await rows(db, `SELECT product, SUM(visitors) AS visitor_days, SUM(visits) AS visits, SUM(views) AS page_views,
      ROUND(100.0 * SUM(bounces) / NULLIF(SUM(visits), 0)) AS bounce_pct, SUM(signups) AS signups,
      ROUND(100.0 * SUM(signups) / NULLIF(SUM(visitors), 0), 1) AS conv_pct, SUM(revenue_cents) / 100 AS revenue, SUM(bot_views) AS bot_views
      FROM days WHERE host = '*' AND day >= '${since}' ${pf} GROUP BY product ORDER BY visits DESC`));
    console.log("\nChannels (visits):");
    table(await rows(db, `SELECT d.product, c.k AS channel, SUM(c.visits) AS visits FROM days d, UNNEST(CAST(json(d.channels) AS JSON[])) AS u(c0), LATERAL (SELECT c0->>'k' AS k, CAST(c0->>'visits' AS INT) AS visits) c
      WHERE d.host = '*' AND d.day >= '${since}' ${pf.replace("product", "d.product")} GROUP BY ALL ORDER BY d.product, visits DESC`));
    return;
  }
  if (cmd === "channels" || cmd === "funnel") {
    provenance("Origin = the person's first known visit (method in `attribution_method`).");
    table(await rows(db, `WITH v AS (SELECT product, channel, coalesce(nullif(ai_source, ''), '') AS ai, COUNT(DISTINCT visit_id) AS visits FROM events
          WHERE event = '$pageview' AND NOT coalesce(is_bot, false) AND channel != 'Internal' AND received_at >= epoch_ms(TIMESTAMPTZ '${since} 00:00:00+00') ${pf} GROUP BY ALL),
        s AS (SELECT product, coalesce(first_touch->>'channel', 'Unknown') AS channel, coalesce(first_touch->>'ai_source', '') AS ai, COUNT(*) AS signed_up,
          SUM(CASE WHEN ltv_cents > 0 THEN 1 ELSE 0 END) AS paying, SUM(ltv_cents) / 100 AS revenue FROM people WHERE created_at >= '${since}' ${pf} GROUP BY ALL)
      SELECT coalesce(v.product, s.product) AS product, coalesce(v.channel, s.channel) AS channel, coalesce(v.ai, s.ai) AS ia, coalesce(visits, 0) AS visits,
        coalesce(signed_up, 0) AS signed_up, ROUND(100.0 * coalesce(signed_up, 0) / NULLIF(visits, 0), 1) AS conv_pct, coalesce(paying, 0) AS paying, coalesce(revenue, 0) AS revenue
      FROM v FULL JOIN s ON v.product = s.product AND v.channel = s.channel AND v.ai = s.ai ORDER BY visits DESC`));
    if (cmd === "funnel" && PRODUCT) {
      const catalog = JSON.parse(readFileSync(path.join(ROOT, "config", "events", `${PRODUCT}.json`), "utf8"));
      console.log(`\nActivation = \`${catalog.activation}\`:`);
      table(await rows(db, `SELECT coalesce(p.first_touch->>'channel', 'Unknown') AS channel, COUNT(*) AS signed_up,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.product = p.product AND e.user_id = p.user_id AND e.event = ${sq(catalog.activation)})) AS actives,
          COUNT(*) FILTER (WHERE p.ltv_cents > 0) AS paying FROM people p WHERE p.product = ${sq(PRODUCT)} AND p.created_at >= '${since}' GROUP BY ALL ORDER BY signed_up DESC`));
    }
    return;
  }
  if (cmd === "pages") {
    provenance();
    table(await rows(db, `SELECT host, path, COUNT(*) FILTER (WHERE event = '$pageview') AS views, COUNT(DISTINCT visit_id) AS visits, ROUND(AVG(engaged_ms) FILTER (WHERE event = '$pageleave') / 1000) AS active_seconds
      FROM events WHERE event IN ('$pageview', '$pageleave') AND NOT coalesce(is_bot, false) AND received_at >= epoch_ms(TIMESTAMPTZ '${since} 00:00:00+00') ${pf}
      GROUP BY ALL HAVING views > 0 ORDER BY views DESC LIMIT 30`));
    return;
  }
  if (cmd === "user") {
    const who = argv[1];
    const p = await rows(db, `SELECT * FROM people WHERE lower(email) = lower(${sq(who)}) OR user_id = ${sq(who)}`);
    if (!p.length) { console.log("Unknown person (run csa sync?)."); return; }
    for (const person of p) {
      console.log(`## ${person.email ?? person.user_id} · ${person.product}\n`);
      table([{ signed_up_at: person.created_at, plan: person.plan, ltv: (person.ltv_cents ?? 0) / 100, method: person.attribution_method, origin: person.first_touch }]);
      console.log("\nEvents (last 50):");
      table(await rows(db, `SELECT strftime(to_timestamp(received_at / 1000), '%Y-%m-%d %H:%M') AS at, event, host, path, channel, props FROM events WHERE product = ${sq(person.product)} AND user_id = ${sq(person.user_id)} ORDER BY received_at DESC LIMIT 50`));
      console.log("\nPayments:");
      table(await rows(db, `SELECT created_at, kind, amount_cents / 100 AS amount, currency FROM payments WHERE product = ${sq(person.product)} AND user_id = ${sq(person.user_id)} ORDER BY created_at DESC`));
      console.log("\nReplays:");
      table(await rows(db, `SELECT id, day, (last_at - started_at) / 1000 AS seconds, clicks, errors FROM replay_sessions WHERE product = ${sq(person.product)} AND user_id = ${sq(person.user_id)} ORDER BY started_at DESC`));
    }
    return;
  }
  if (cmd === "replays") {
    provenance("Raw replays are kept 30 days. Watch them in the dashboard, #/r/<id>.");
    table(await rows(db, `SELECT r.id, r.product, coalesce(p.email, r.user_id) AS person, r.day, (r.last_at - r.started_at) / 1000 AS seconds, r.clicks, r.errors, r.pages
      FROM replay_sessions r LEFT JOIN people p USING (product, user_id) WHERE r.day >= '${since}' ${pf.replace("product", "r.product")} ORDER BY r.errors DESC, seconds DESC LIMIT 50`));
    return;
  }
  if (cmd === "today") {
    console.log(`> Today (UTC), raw files not yet compacted, read straight from R2. Visitors = distinct fingerprints.\n`);
    table(await rows(db, `SELECT product, COUNT(*) FILTER (WHERE event = '$pageview' AND NOT coalesce(is_bot, false)) AS page_views,
      COUNT(DISTINCT coalesce(user_id, anon_id, day_hash)) FILTER (WHERE event = '$pageview' AND NOT coalesce(is_bot, false)) AS visitors,
      COUNT(*) FILTER (WHERE channel = 'AI' AND event = '$pageview') AS ai_views, COUNT(*) FILTER (WHERE event NOT LIKE '$%') AS product_events,
      COUNT(*) FILTER (WHERE coalesce(is_bot, false)) AS bots
      FROM events WHERE received_at >= epoch_ms(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') ${pf} GROUP BY product`));
    return;
  }
  throw new Error(`Unknown command: ${cmd}. csa help`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
