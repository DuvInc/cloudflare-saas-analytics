#!/usr/bin/env node
/*
  npm run setup: creates the Cloudflare resources this Worker needs in YOUR account, writes
  wrangler.jsonc, runs the migrations, builds and deploys, sets the two secrets it cannot work
  without, and prints the first passkey enrollment link.

    npm run setup                 interactive
    npm run setup -- --dry-run    print every command, change nothing
    npm run setup -- --no-pipeline   skip the Pipelines stream (see README: running without it)

  Progress is saved in .setup-state.json (gitignored): if a step fails, fix the cause and run it
  again, finished steps are skipped. Needs Node 22+ and `npx wrangler login` done once.
*/
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");
const NO_PIPELINE = process.argv.includes("--no-pipeline");
const STATE_FILE = path.join(ROOT, ".setup-state.json");
const state = existsSync(STATE_FILE) && !DRY ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => { if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); };

if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22 or newer is required."); process.exit(1); }

const wrangler = (args, { input, fake = "" } = {}) => {
  const printable = `wrangler ${args.join(" ")}`;
  if (DRY) { console.log(`  [dry-run] ${printable}`); return fake; }
  console.log(`  $ ${printable}`);
  try {
    return execFileSync(path.join(ROOT, "node_modules", ".bin", "wrangler"), args, { cwd: ROOT, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error(`\nFailed: ${printable}\n${e.stderr || e.stdout || e.message}`);
    process.exit(1);
  }
};
const npm = (script) => {
  if (DRY) return console.log(`  [dry-run] npm run ${script}`);
  console.log(`  $ npm run ${script}`);
  execFileSync("npm", ["run", script], { cwd: ROOT, stdio: "inherit" });
};
const step = async (name, fn) => {
  if (state[name] !== undefined && !DRY) { console.log(`✓ ${name} (done before)`); return state[name]; }
  console.log(`\n▸ ${name}`);
  const out = await fn();
  state[name] = out ?? true;
  save();
  return state[name];
};

/* Interactive on a terminal; with piped input (CI, tests) the answers are read in advance, one per line. */
const piped = !process.stdin.isTTY ? readFileSync(0, "utf8").split(/\r?\n/) : null;
const rl = piped ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, d = "") => {
  const prompt = `${q}${d ? ` [${d}]` : ""}: `;
  if (piped) { const line = (piped.shift() ?? "").trim(); console.log(`${prompt}${line}`); return line || d; }
  return (await rl.question(prompt)).trim() || d;
};
const yes = async (q, d = "y") => /^y/i.test(await ask(`${q} (y/n)`, d));

console.log("Cloudflare SaaS Analytics setup" + (DRY ? " (dry run: nothing is created)" : "") + "\n");

/* ------------------------------------------------------------------ account */
const who = wrangler(["whoami", "--json"], { fake: JSON.stringify({ accounts: [{ id: "0".repeat(32), name: "dry-run" }] }) });
let accounts = [];
try { accounts = JSON.parse(who).accounts ?? []; } catch { /* not logged in */ }
if (!accounts.length) { console.error("Not logged in. Run `npx wrangler login` first."); process.exit(1); }
let account = accounts[0];
if (accounts.length > 1) {
  accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (${a.id})`));
  account = accounts[Number(await ask("Which account", "1")) - 1] ?? accounts[0];
}
process.env.CLOUDFLARE_ACCOUNT_ID = account.id;
console.log(`Account: ${account.name}`);

/* ------------------------------------------------------------------ answers */
const answers = await step("answers", async () => {
  const name = await ask("Name for the Worker and its resources", "saas-analytics");
  const operator = await ask("Your name (shown in the passkey prompt)", "Operator");
  const products = [];
  console.log("\nProducts: one per site or app you want to measure. Its domain must be a zone of this account.");
  do {
    const domain = (await ask("  Domain (e.g. example.com)")).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { console.log("  Not a domain, try again."); continue; }
    const id = await ask("  Product id (lowercase, dashes)", domain.split(".")[0].replace(/[^a-z0-9-]/g, "-"));
    const label = await ask("  Display name", id);
    const prefix = await ask("  Collection host prefix (the tracker loads from <prefix>.<domain>)", "t");
    const currency = (await ask("  Revenue currency (eur, usd, ...)", "usd")).toLowerCase();
    const replay = await yes("  Record session replays of signed-in users?", "y");
    products.push({ id, name: label, domain, collect: `${prefix}.${domain}`, replay, replayDailyCap: replay ? 500 : 0, currency });
  } while (await yes("Add another product?", "n"));
  const bots = await yes("Track AI crawlers and bots? (needs an API token later, see README)", "n");
  return { name, operator, products, bots };
});

/* ---------------------------------------------------------------- resources */
const d1Id = await step("D1 database", () => {
  const out = wrangler(["d1", "create", answers.name], { fake: 'database_id = "11111111-1111-1111-1111-111111111111"' });
  return /database_id["\s:=]+"?([0-9a-f-]{36})/.exec(out)?.[1] ?? (console.error("Could not read the database id from the output above."), process.exit(1));
});
await step("R2 bucket", () => { wrangler(["r2", "bucket", "create", answers.name]); });
const kvId = await step("KV namespace", () => {
  const out = wrangler(["kv", "namespace", "create", `${answers.name}-salts`], { fake: '"id": "22222222222222222222222222222222"' });
  return /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(out)?.[1] ?? (console.error("Could not read the KV id from the output above."), process.exit(1));
});

let streamId = "00000000000000000000000000000000";
if (!NO_PIPELINE) {
  streamId = await step("Pipelines stream, R2 sink and pipeline", () => {
    const stream = `${answers.name.replace(/-/g, "_")}_events`;
    const sink = `${answers.name.replace(/-/g, "_")}_raw`;
    wrangler(["pipelines", "streams", "create", stream, "--schema-file", "schema/stream.json", "--http-enabled", "false"]);
    wrangler(["pipelines", "sinks", "create", sink, "--type", "r2", "--bucket", answers.name, "--format", "json", "--compression", "gzip", "--path", "raw", "--partitioning", "year=%Y/month=%m/day=%d", "--roll-interval", "300"]);
    wrangler(["pipelines", "create", answers.name.replace(/-/g, "_"), "--sql", `INSERT INTO ${sink} SELECT * FROM ${stream}`]);
    const list = wrangler(["pipelines", "streams", "list", "--json"], { fake: JSON.stringify([{ name: stream, id: streamId }]) });
    const found = (JSON.parse(list) ?? []).find((s) => s.name === stream);
    if (!found?.id) { console.error(`Stream ${stream} created but its id could not be read: run \`wrangler pipelines streams list\` and put it in wrangler.jsonc.`); process.exit(1); }
    return found.id;
  });
}

/* ------------------------------------------------------------------- config */
await step("wrangler.jsonc", () => {
  let text = readFileSync(path.join(ROOT, "wrangler.example.jsonc"), "utf8");
  const routes = answers.products.map((p) => `{ "pattern": "${p.collect}", "custom_domain": true }`).join(",\n    ");
  const rl1 = 100000 + Math.floor(Math.random() * 800000), rl2 = rl1 + 1;
  const fill = {
    __WORKER_NAME__: answers.name, __ROUTES__: routes, __D1_NAME__: answers.name, __D1_ID__: d1Id, __R2_NAME__: answers.name, __KV_ID__: kvId,
    __STREAM_ID__: streamId, __RATELIMIT_NS_1__: String(rl1), __RATELIMIT_NS_2__: String(rl2), __OPERATOR_NAME__: answers.operator.replace(/"/g, ""),
    __ACCOUNT_ID__: account.id, __BOTS_SINCE__: new Date(Date.now() - 86400_000).toISOString().slice(0, 13),
    __PRODUCTS__: JSON.stringify(answers.products, null, 6).replace(/\n/g, "\n    "),
  };
  for (const [k, v] of Object.entries(fill)) text = text.split(k).join(v);
  if (NO_PIPELINE) text = text.replace(/\n\s*"pipelines":[^\n]*/, "");
  if (!answers.bots) text = text.replace(/\n\s*"BOTS":[^\n]*/, "");
  const target = DRY ? "wrangler.dry-run.jsonc" : "wrangler.jsonc";
  writeFileSync(path.join(ROOT, target), text);
  if (DRY) console.log(`  [dry-run] wrote ${target} for inspection (delete it after)`);
});

await step("migrations", () => npm("migrate"));
await step("build and deploy", () => {
  npm("build:client");
  npm("build:web");
  const out = wrangler(["deploy"], { fake: "https://saas-analytics.example.workers.dev" });
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(out)?.[0] ?? "";
  if (url && !DRY) {
    const file = path.join(ROOT, "wrangler.jsonc");
    writeFileSync(file, readFileSync(file, "utf8").replace('"DASHBOARD_URL": ""', `"DASHBOARD_URL": "${url}"`));
  }
  return url;
});
await step("secrets", () => {
  for (const name of ["IDENTITY_SECRET", "OPERATOR_SECRET"]) wrangler(["secret", "put", name], { input: randomBytes(32).toString("base64url") + "\n" });
});

const dashboard = state["build and deploy"];
console.log("\nDone.");
console.log(`\nDashboard: ${dashboard || "(see the deploy output above)"}`);
console.log("\nNext:");
console.log("  1. Register your first passkey:  npm run csa -- enroll   (open the link on your device, 30 minutes)");
console.log("  2. Put the tracker on each site:");
for (const p of answers.products) console.log(`       <script defer src="https://${p.collect}/t.js"></script>   (${p.name})`);
console.log("  3. Add the WAF rule to each zone so scanners never reach the Worker (README, 'Cloudflare WAF rule').");
console.log("  4. Optional: reports, bots, Stripe, natural-language filters, see the README.");
rl?.close();
