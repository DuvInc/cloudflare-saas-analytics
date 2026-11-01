import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    ctx: unknown;
  },
}));

import { handleCollect } from "../src/collect";
import { filteredDays } from "../src/explore";
import { gunzipBounded, operatorSecurityHeaders, rateLimitIpKey, readBoundedBytes, readBoundedText } from "../src/http-security";
import { signUser } from "../src/identity";
import worker from "../src/index";
import { computeFunnel, computeProductFunnels } from "../src/journeys";
import { authApi } from "../src/operator/auth";
import { ReadContext } from "../src/read-context";
import { handleReplay } from "../src/replay";
import { compactTodayHours } from "../src/rollup";

afterEach(() => vi.useRealTimers());

const PRODUCTS = [
  { id: "acme", name: "Acme", domain: "acme.com", collect: "t.acme.com", replay: true, replayDailyCap: 100, currency: "eur" },
  { id: "globex", name: "Globex", domain: "globex.app", collect: "t.globex.app", replay: true, replayDailyCap: 100, currency: "eur" },
];

function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  const migDir = resolve(import.meta.dirname, "../migrations");
  for (const file of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(resolve(migDir, file), "utf8"));
  }
  const executed: string[] = [];
  const makeStmt = (sql: string, bound: unknown[] = []) => ({
    sql,
    bind(...args: unknown[]) {
      return makeStmt(sql, args);
    },
    async all<T = Record<string, unknown>>() {
      executed.push(sql);
      const st = sqlite.prepare(sql);
      const rows = st.all(...(bound as never[])) as T[];
      return { results: rows, success: true, meta: {} };
    },
    async first<T = Record<string, unknown>>() {
      executed.push(sql);
      const st = sqlite.prepare(sql);
      const row = st.get(...(bound as never[])) as T | undefined;
      return row ?? null;
    },
    async run() {
      executed.push(sql);
      const st = sqlite.prepare(sql);
      const res = st.run(...(bound as never[]));
      return { success: true, meta: { changes: Number(res.changes) } };
    },
  });
  const db = {
    prepare: (sql: string) => makeStmt(sql),
    async batch(stmts: ReturnType<typeof makeStmt>[]) {
      const out = [];
      for (const s of stmts) {
        if (/^\s*SELECT/i.test(s.sql)) out.push(await s.all());
        else out.push(await s.run());
      }
      return out;
    },
  };
  return { sqlite, db, executed };
}

function fullTestEnv() {
  const { sqlite, db, executed } = sqliteD1();
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  const sinkRows: Record<string, unknown>[] = [];
  const bucket = {
    async list({ prefix, limit }: { prefix: string; cursor?: string; limit?: number }) {
      const matched = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, o]) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded }));
      return { objects: limit ? matched.slice(0, limit) : matched, truncated: false };
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: new Blob([o.bytes]).stream(),
        arrayBuffer: async () => o.bytes.slice().buffer,
        json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
        text: async () => new TextDecoder().decode(o.bytes),
        httpMetadata: { contentType: key.endsWith(".gz") ? "application/gzip" : "application/json" },
      };
    },
    async put(key: string, body: ArrayBuffer | Uint8Array | string) {
      const bytes = typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Uint8Array
          ? body.slice()
          : new Uint8Array(body);
      objects.set(key, { bytes, uploaded: new Date() });
    },
    async delete(keys: string[] | string) {
      for (const k of [keys].flat()) objects.delete(k);
    },
  };
  const kvMap = new Map<string, string>();
  const kv = {
    async get(k: string) { return kvMap.get(k) ?? null; },
    async put(k: string, v: string) { kvMap.set(k, v); },
    async delete(k: string) { kvMap.delete(k); },
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) { waitUntilPromises.push(p); },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const env = {
    DB: db,
    BUCKET: bucket,
    KV: kv,
    STREAM: { async send(rows: Record<string, unknown>[]) { sinkRows.push(...rows); } },
    PER_IP: { async limit() { return { success: true }; } },
    PER_PRODUCT: { async limit() { return { success: true }; } },
    ASSETS: { async fetch() { return new Response("asset-ok", { status: 200 }); } },
    PRODUCTS: JSON.stringify(PRODUCTS),
    DASHBOARD_HOSTS: "analytics.example.com",
    OPERATOR_NAME: "Operator",
    SIGNING_SECRET: "test-signing-secret-0123456789abcdef",
    HASH_SECRET: "test-hash-secret-0123456789abcdef",
    IDENTITY_SECRET: "test-identity-secret-0123456789abcdef",
  } as never;
  const flush = async () => { await Promise.all(waitUntilPromises.splice(0)); };
  return { env, sqlite, executed, objects, sinkRows, ctx, flush };
}

describe("HTTP security primitives", () => {
  it("normalizes IPv6 /64 prefixes and IPv4 addresses for rate limiting", () => {
    expect(rateLimitIpKey("203.0.113.42")).toBe("203.0.113.42");
    expect(rateLimitIpKey("2001:db8:abcd:0012:1111:2222:3333:4444")).toBe("2001:db8:abcd:12::/64");
    expect(rateLimitIpKey("2001:0db8:abcd:12::9999")).toBe("2001:db8:abcd:12::/64");
    expect(rateLimitIpKey("::ffff:192.0.2.5")).toBe("192.0.2.5");
  });

  it("enforces streaming byte limits without trusting Content-Length and rejects gzip bombs", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(20_000));
        c.enqueue(new Uint8Array(20_000));
        c.close();
      },
    });
    const req = new Request("https://t.acme.com/e", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readBoundedBytes(req, 32 * 1024)).toBeNull();

    const smallReq = new Request("https://t.acme.com/e", { method: "POST", body: "hello" });
    expect(await readBoundedText(smallReq, 1024)).toBe("hello");

    const bombCompressed = gzipSync(Buffer.alloc(6 * 1024 * 1024, 0));
    expect(bombCompressed.byteLength).toBeLessThan(64 * 1024);
    expect(await gunzipBounded(bombCompressed, 4 * 1024 * 1024)).toBeNull();

    const okCompressed = gzipSync(Buffer.from(JSON.stringify([{ type: 2 }])));
    const unzipped = await gunzipBounded(okCompressed, 4 * 1024 * 1024);
    expect(unzipped).not.toBeNull();
    expect(new TextDecoder().decode(unzipped!)).toBe('[{"type":2}]');
  });

  it("emits strict CSP without unsafe-inline in script-src and scopes product origins to passive assets", () => {
    const headers = operatorSecurityHeaders(PRODUCTS);
    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("img-src 'self' data: blob: https://acme.com https://*.acme.com");
    expect(headers["x-frame-options"]).toBe("DENY");
  });
});

describe("Collector privacy & D1 recent_visits deduplication", () => {
  it("never records anon_id without explicit consent or under DNT, and deduplicates recent_visits", async () => {
    const { env, sqlite, executed, sinkRows, ctx, flush } = fullTestEnv();
    const product = PRODUCTS[0]!;
    const send = async (c: number | null, dnt = false, cookie = "csa_id=a_0123456789abcdef01234567") => {
      const req = new Request("https://t.acme.com/e", {
        method: "POST",
        headers: {
          origin: "https://acme.com",
          "cf-connecting-ip": "198.51.100.7",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130.0",
          cookie,
          ...(dnt ? { dnt: "1" } : {}),
        },
        body: JSON.stringify({ c, e: [{ n: "$pageview", u: "https://acme.com/pricing", r: "https://chatgpt.com/" }] }),
      });
      const res = await handleCollect(req, env, ctx, product);
      await flush();
      return res;
    };

    await send(null);
    expect(sinkRows[0]?.anon_id).toBeNull();
    expect(sinkRows[0]?.level).toBe(0);

    const noRes = await send(0);
    expect(sinkRows[1]?.anon_id).toBeNull();
    expect(noRes.headers.get("set-cookie")).toContain("Max-Age=0");

    await send(1, true);
    expect(sinkRows[2]?.anon_id).toBeNull();

    await send(1, false);
    await send(1, false);
    expect(sinkRows[3]?.anon_id).toBe("a_0123456789abcdef01234567");
    expect(sinkRows[3]?.level).toBe(1);

    const rows = sqlite.prepare("SELECT product, ident FROM recent_visits").all();
    expect(rows.length).toBe(2); // h:<day_hash> and a:<anon_id>, never duplicated across repeat pageviews
    const insertCalls = executed.filter((sql) => sql.includes("INSERT OR IGNORE INTO recent_visits"));
    expect(insertCalls.length).toBe(2); // second consented hit skipped D1 via isolate WeakMap cache
    sqlite.close();
  });
});

describe("Session replay security & deduplication", () => {
  it("accepts preflight-free binary token framing, deduplicates (session_id, seq), blocks cross-product hijacking & gzip bombs", async () => {
    const { env, sqlite, objects } = fullTestEnv();
    const p1 = PRODUCTS[0]!;
    const p2 = PRODUCTS[1]!;
    const token1 = await signUser(env, p1.id, "usr_alice", "ws_1");
    const token2 = await signUser(env, p2.id, "usr_alice", "ws_1");
    const session = "rs_AbCdEfGhIjKlMnOpQrSt";

    const gz = gzipSync(Buffer.from(JSON.stringify([{ type: 4, timestamp: 1000, data: {} }])));
    const framed = new Uint8Array(token1.length + 1 + gz.byteLength);
    framed.set(new TextEncoder().encode(`${token1}\n`), 0);
    framed.set(gz, token1.length + 1);

    const makeReq = (origin: string, host: string, q: number, payload: Uint8Array) =>
      new Request(`https://${host}/r?s=${session}&q=${q}&c=3&er=1&pg=/editor`, {
        method: "POST",
        headers: { origin, "cf-connecting-ip": "198.51.100.9" },
        body: payload as BufferSource,
      });

    const first = await handleReplay(makeReq("https://acme.com", "t.acme.com", 0, framed), env, p1);
    expect(first.status).toBe(204);

    // Retry of the exact same (session, seq=0) must be idempotent
    const dup = await handleReplay(makeReq("https://acme.com", "t.acme.com", 0, framed), env, p1);
    expect(dup.status).toBe(204);
    const meta = sqlite.prepare("SELECT chunks, clicks, errors FROM replay_sessions WHERE id = ?").get(session) as { chunks: number; clicks: number; errors: number };
    expect(meta).toEqual({ chunks: 1, clicks: 3, errors: 1 });
    expect(objects.size).toBe(1);

    // Cross-product attempt with valid user token on product 2 trying to append to product 1's session
    const framed2 = new Uint8Array(token2.length + 1 + gz.byteLength);
    framed2.set(new TextEncoder().encode(`${token2}\n`), 0);
    framed2.set(gz, token2.length + 1);
    const cross = await handleReplay(makeReq("https://globex.app", "t.globex.app", 1, framed2), env, p2);
    expect(cross.status).toBe(403);

    // Gzip bomb (5 MB zeros -> ~5 KB gzip) must be rejected with 413 before R2 put
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0));
    const framedBomb = new Uint8Array(token1.length + 1 + bomb.byteLength);
    framedBomb.set(new TextEncoder().encode(`${token1}\n`), 0);
    framedBomb.set(bomb, token1.length + 1);
    const bombRes = await handleReplay(makeReq("https://acme.com", "t.acme.com", 2, framedBomb), env, p1);
    expect(bombRes.status).toBe(413);
    expect(objects.size).toBe(1);
    sqlite.close();
  });
});

describe("Operator auth hardening & asset protection", () => {
  it("evicts oldest challenges FIFO instead of locking out login after 200 challenges, and gates /android/* and /player.js", async () => {
    const { env, sqlite, ctx } = fullTestEnv();
    for (let i = 0; i < 210; i++) {
      const r = await authApi(
        new Request("https://analytics.example.com/api/auth/login/options", {
          method: "POST",
          headers: { origin: "https://analytics.example.com", "cf-connecting-ip": "198.51.100.1" },
          body: "{}",
        }),
        env,
      );
      expect(r.status).toBe(200);
    }
    const active = sqlite.prepare("SELECT COUNT(*) AS n FROM operator_challenges WHERE used = 0").get() as { n: number };
    expect(active.n).toBeLessThanOrEqual(200);

    // Unauthenticated requests to /android/* and /player.js are blocked
    const apkRes = await worker.fetch(new Request("https://analytics.example.com/android/saas-analytics.apk"), env, ctx);
    expect(apkRes.status).toBe(401);
    const playerRes = await worker.fetch(new Request("https://analytics.example.com/player.js"), env, ctx);
    expect(playerRes.status).toBe(401);

    // Index shell carries strict CSP
    const htmlRes = await worker.fetch(new Request("https://analytics.example.com/"), env, ctx);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-security-policy")).toContain("script-src 'self'");
    sqlite.close();
  });
});

describe("Hourly compaction, empty-manifest zero-I/O, and streaming funnels", () => {
  it("compacts settled hours of today and reads hourly cache + raw tail seamlessly", async () => {
    vi.useFakeTimers();
    const base = Date.parse("2026-11-01T00:00:00Z");
    const now = base + 3 * 3600_000 + 40 * 60_000; // 03:40 UTC -> hours 00, 01, 02 settled; hour 03 open
    vi.setSystemTime(now);
    const { env, sqlite, objects } = fullTestEnv();

    const putRaw = (name: string, ts: number, path: string) => {
      const line = JSON.stringify({ product: "acme", host: "acme.com", event: "$pageview", received_at: ts, ts, day_hash: `h_${name}`, path }) + "\n";
      objects.set(`raw/${name}.ndjson.gz`, { bytes: new Uint8Array(gzipSync(line)), uploaded: new Date(ts + 60_000) });
    };
    putRaw("h0", base + 10 * 60_000, "/h0");
    putRaw("h1", base + 75 * 60_000, "/h1");
    putRaw("h3", base + 3 * 3600_000 + 15 * 60_000, "/h3");

    const compacted = await compactTodayHours(env, now);
    expect(compacted).toBe(3); // 00, 01, 02
    expect(objects.has("cache/hours/2026-11-01/00.ndjson.gz")).toBe(true);
    expect(objects.has("cache/hours/2026-11-01/02.ndjson.gz")).toBe(true);

    // Delete raw/h0 to prove ReadContext reads settled hours from cache/hours/ rather than re-reading old raw/ files
    objects.delete("raw/h0.ndjson.gz");

    const context = new ReadContext(env);
    const events = await context.dayReadOnly("2026-11-01", "2026-11-01");
    expect(events.map((e) => e.path).sort()).toEqual(["/h0", "/h1", "/h3"]);

    // Empty closed-day manifest must not read or write R2 `cache/explore/v2/...`
    sqlite.prepare("INSERT INTO runs (job, key, status, ran_at, files) VALUES ('rollup', '2026-10-31', 'ok', '2026-11-01T00:35:00Z', '[]')").run();
    const filtered = await filteredDays(env, "acme", "*", "2026-10-31", 1, [{ dim: "country", value: "FR" }], new ReadContext(env));
    expect(filtered).toEqual([]);
    expect([...objects.keys()].some((k) => k.startsWith("cache/explore/"))).toBe(false);
    sqlite.close();
  });

  it("streams multi-day funnels with identical results to in-memory computeFunnel", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-11-01T12:00:00Z");
    vi.setSystemTime(now);
    const { env, sqlite, objects } = fullTestEnv();
    sqlite.prepare("INSERT INTO identities (product, kind, value, user_id, method, at) VALUES ('acme', 'hash', 'v_ai', 'u_paid', 'hash', '2026-10-31T10:00:00Z')").run();

    const d1Events = [
      { product: "acme", host: "acme.com", event: "$pageview", path: "/blog/guide", day_hash: "v_ai", channel: "AI", ai_source: "ChatGPT", origin: "web", received_at: Date.parse("2026-10-30T10:00:00Z") },
      { product: "acme", host: "acme.com", event: "$pageview", path: "/pricing", day_hash: "v_org", channel: "Organic Search", origin: "web", received_at: Date.parse("2026-10-30T11:00:00Z") },
      { product: "acme", host: "", event: "signup_completed", user_id: "u_srv", origin: "server", received_at: Date.parse("2026-10-30T12:00:00Z") },
    ];
    const d2Events = [
      { product: "acme", host: "", event: "signup_completed", user_id: "u_paid", origin: "server", received_at: Date.parse("2026-10-31T10:00:00Z") },
      { product: "acme", host: "", event: "site_published", user_id: "u_paid", origin: "server", received_at: Date.parse("2026-10-31T11:00:00Z") },
      { product: "acme", host: "", event: "site_published", user_id: "u_srv", origin: "server", received_at: Date.parse("2026-10-31T12:30:00Z") },
    ];

    objects.set("daily/2026-10-30/part-000.ndjson.gz", { bytes: new Uint8Array(gzipSync(d1Events.map((e) => JSON.stringify(e)).join("\n") + "\n")), uploaded: new Date(now) });
    objects.set("daily/2026-10-31/part-000.ndjson.gz", { bytes: new Uint8Array(gzipSync(d2Events.map((e) => JSON.stringify(e)).join("\n") + "\n")), uploaded: new Date(now) });
    sqlite.prepare("INSERT INTO runs (job, key, status, ran_at, files) VALUES ('rollup', '2026-10-30', 'ok', 'v1', ?)").run(JSON.stringify(["daily/2026-10-30/part-000.ndjson.gz"]));
    sqlite.prepare("INSERT INTO runs (job, key, status, ran_at, files) VALUES ('rollup', '2026-10-31', 'ok', 'v1', ?)").run(JSON.stringify(["daily/2026-10-31/part-000.ndjson.gz"]));

    const steps = [{ kind: "event" as const, value: "signup_completed" }, { kind: "event" as const, value: "site_published" }];
    const defs = [{ id: "act", product: "acme", name: "Signup to publish", description: "", steps }];
    const streamed = await computeProductFunnels(env, defs, 3, new ReadContext(env));
    const expected = computeFunnel([...d1Events, ...d2Events], steps, new Map([["h:v_ai", "u_paid"]]));

    expect(streamed[0]?.steps).toEqual(expected.steps);
    expect(streamed[0]?.byChannel).toEqual(expected.byChannel);
    expect(streamed[0]?.byChannel.find((c) => c.k === "Server")).toEqual({ k: "Server", entered: 1, converted: 1 });
    expect(streamed[0]?.byChannel.find((c) => c.k === "AI \u00b7 ChatGPT")).toEqual({ k: "AI \u00b7 ChatGPT", entered: 1, converted: 1 });
    sqlite.close();
  });
});
