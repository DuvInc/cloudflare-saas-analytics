import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { R2Reader } from "./r2-read.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const baseline = flag("baseline");
if (!baseline || !/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error("benchmark.mjs --baseline <git SHA> [--output /absolute/file.json] [--latency-ms 10]");
const latency = Number(flag("latency-ms", "10"));
if (!Number.isFinite(latency) || latency < 0 || latency > 1000) throw new Error("Invalid latency");
const scratch = mkdtempSync(path.join(tmpdir(), "csa-benchmark-"));
const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
const relative = path.relative(repository, root);
const archive = execFileSync("git", ["archive", baseline, `${relative}/src`], { cwd: repository, maxBuffer: 20 * 1024 * 1024 });
execFileSync("tar", ["-x", "-C", scratch], { input: archive });
for (const [name, source] of [["before", path.join(scratch, relative, "src/explore.ts")], ["after", path.join(root, "src/explore.ts")]]) {
  await build({ entryPoints: [source], outfile: path.join(scratch, `${name}.mjs`), bundle: true, platform: "node", format: "esm" });
}
const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const dayOf = (offset) => new Date(midnight - offset * 86400_000).toISOString().slice(0, 10);
if (args.includes("--remote-raw")) {
  const source = new R2Reader(root);
  const snapshot = await source.list({ prefix: "raw/", limit: 1000 });
  if (snapshot.truncated) throw new Error("Remote benchmark cap: more than 1000 raw files");
  const allowed = new Set(snapshot.objects.map((object) => object.key));
  const results = [];
  let expected;
  for (const warm of [false, true]) {
    const sides = { before: [], after: [] };
    for (let run = 0; run < 5; run++) {
      for (const side of run % 2 ? ["after", "before"] : ["before", "after"]) {
        const module = await import(`${pathToFileURL(path.join(scratch, `${side}.mjs`))}?remote=${warm}&run=${run}`);
        const reader = new R2Reader(root);
        const bucket = {
          get: (key) => reader.get(key),
          async list(options) {
            const page = await reader.list(options);
            return { ...page, objects: page.objects.filter((object) => allowed.has(object.key)) };
          },
        };
        const env = { BUCKET: bucket };
        if (warm) await module.dayEvents(env, dayOf(0), dayOf(0));
        reader.count.get = 0; reader.count.list = 0;
        const start = performance.now();
        const events = await module.dayEvents(env, dayOf(0), dayOf(0));
        const ms = performance.now() - start;
        const canonical = JSON.stringify(events);
        if (expected === undefined) expected = canonical;
        if (canonical !== expected) throw new Error(`Remote output mismatch: ${side}/${run}`);
        sides[side].push({ ms, ...reader.count, events: events.length, r2_usage_usd: (reader.count.list * 4.5 + reader.count.get * 0.36) / 1e6 });
      }
    }
    const summarize = (runs) => ({ median_ms: runs.map((run) => run.ms).sort((left, right) => left - right)[2], min_ms: Math.min(...runs.map((run) => run.ms)), max_ms: Math.max(...runs.map((run) => run.ms)), operations: { get: runs[0].get, list: runs[0].list }, r2_usage_usd: runs[0].r2_usage_usd });
    const before = summarize(sides.before), after = summarize(sides.after);
    const result = { scenario: warm ? "production-raw-repeated-read" : "production-raw-first-read", before, after, faster_percent: 100 * (1 - after.median_ms / before.median_ms), r2_usage_reduction_percent: 100 * (1 - after.r2_usage_usd / before.r2_usage_usd), runs: sides };
    results.push(result); console.log(JSON.stringify(result));
  }
  const report = { at: new Date().toISOString(), baseline, method: "Real production R2 GET/LIST, local bundled day-event reader. Frozen raw-key set, exact event equality, five alternating runs per side. No writes to R2. Excludes dashboard rendering, authentication, D1, aggregation, storage, quota and billing rounding. Not a whole-dashboard benchmark.", snapshot_files: allowed.size, results };
  const output = flag("output", path.join(scratch, "remote-results.json"));
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`Results: ${output}`); process.exit(0);
}
const fixture = (history) => {
  const objects = new Map();
  const manifests = [];
  for (let offset = 0; offset <= history; offset++) {
    const day = dayOf(offset);
    const files = [];
    for (let part = 0; part < (offset === 0 ? 24 : 2); part++) {
      const key = offset === 0 ? `raw/${part}.gz` : `daily/${day}/part-${part}.ndjson.gz`;
      const body = Array.from({ length: 60 }, (_, index) => ({ product: index % 2 ? "p" : "other", host: "p.com", event: "$pageview", path: index % 3 ? "/jobs/a" : "/", channel: "Direct", country: index % 3 ? "DE" : "FR", day_hash: `${part}-${index}`, received_at: midnight - offset * 86400_000 + 1000, ts: 0 })).map((row) => JSON.stringify(row)).join("\n");
      objects.set(key, { bytes: gzipSync(body), uploaded: new Date(midnight - offset * 86400_000 + 1500) });
      files.push(key);
    }
    if (offset) manifests.push({ key: day, ran_at: `${day}T23:59:59Z`, files: JSON.stringify(files) });
  }
  return { objects, manifests };
};
function environment(history) {
  const { objects, manifests } = fixture(history);
  const count = { get: 0, list: 0, put: 0, d1: 0 };
  const wait = () => latency ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve();
  const bucket = {
    async list({ prefix }) { count.list++; await wait(); return { objects: [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, item]) => ({ key, uploaded: item.uploaded })), truncated: false }; },
    async get(key) { count.get++; await wait(); const item = objects.get(key); return item ? { arrayBuffer: async () => item.bytes, httpMetadata: key.endsWith(".json") ? {} : { contentType: "application/gzip" }, json: async () => JSON.parse(item.bytes.toString("utf8")), text: async () => item.bytes.toString("utf8") } : null; },
    async put(key, value) { count.put++; await wait(); objects.set(key, { bytes: Buffer.from(value), uploaded: new Date() }); },
  };
  const db = { prepare(sql) { return { bind() { return this; }, async all() { count.d1++; await wait(); return { results: sql.includes("SELECT key, ran_at, files FROM runs") ? manifests : [] }; } }; } };
  return { env: { BUCKET: bucket, DB: db }, count };
}
const scenarios = [
  { name: "new-install-30d-first-filter", history: 1, repeat: false, change: false },
  { name: "established-30d-first-filter", history: 59, repeat: false, change: false },
  { name: "established-30d-repeated-filter", history: 59, repeat: true, change: false },
  { name: "established-30d-new-filter-after-first", history: 59, repeat: true, change: true },
];
const results = [];
for (const scenario of scenarios) {
  const measured = { before: [], after: [] };
  let expected;
  for (let run = 0; run < 5; run++) {
    for (const side of run % 2 ? ["after", "before"] : ["before", "after"]) {
      const { filteredDays } = await import(`${pathToFileURL(path.join(scratch, `${side}.mjs`))}?case=${scenario.name}&run=${run}`);
      const { env, count } = environment(scenario.history);
      const filters = [{ dim: "country", value: "DE" }];
      if (scenario.repeat) await filteredDays(env, "p", "*", dayOf(59), 60, filters);
      for (const key of Object.keys(count)) count[key] = 0;
      const start = performance.now();
      const rows = await filteredDays(env, "p", "*", dayOf(59), 60, scenario.change ? [{ dim: "page", value: "/jobs/a" }] : filters);
      const ms = performance.now() - start;
      const canonical = JSON.stringify(rows);
      if (expected === undefined) expected = canonical;
      if (!isDeepStrictEqual(canonical, expected)) throw new Error(`Result mismatch: ${scenario.name}, ${side}, ${run}`);
      const usd = (count.list + count.put) * 4.5 / 1e6 + count.get * 0.36 / 1e6;
      measured[side].push({ ms, ...count, r2_usage_usd: usd });
    }
  }
  const summary = (runs) => {
    const ordered = runs.map((run) => run.ms).sort((left, right) => left - right);
    return { median_ms: ordered[2], min_ms: ordered[0], max_ms: ordered[4], operations: { get: runs[0].get, list: runs[0].list, put: runs[0].put, d1: runs[0].d1 }, r2_usage_usd: runs[0].r2_usage_usd };
  };
  const before = summary(measured.before), after = summary(measured.after);
  const result = { scenario: scenario.name, before, after, faster_percent: 100 * (1 - after.median_ms / before.median_ms), r2_usage_reduction_percent: 100 * (1 - after.r2_usage_usd / before.r2_usage_usd), runs: measured };
  results.push(result); console.log(JSON.stringify(result));
}
const report = { at: new Date().toISOString(), baseline, method: "Synthetic gzip events, real bundled filter engine, local R2/D1 doubles, five alternating runs per version, exact output equality. Not browser or production latency; R2 unit usage excludes quotas, rounding, storage, D1 and Worker CPU.", latency_ms_per_operation: latency, results };
const output = flag("output", path.join(scratch, "results.json"));
mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Results: ${output}`);
