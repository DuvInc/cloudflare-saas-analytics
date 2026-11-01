import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { identify } from "../src/rpc";
import { dayHash } from "../src/identity";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    first: async () => sqlite.prepare(sql).get(...args as never[]) ?? null,
    run: async () => sqlite.prepare(sql).run(...args as never[]),
  });
  const sent: unknown[] = [];
  const salts = new Map<string, string>();
  const env = { DB: { prepare: stmt, batch: async (statements: ReturnType<typeof stmt>[]) => Promise.all(statements.map((s) => s.run())) }, KV: { get: async (key: string) => salts.get(key) ?? null, put: async (key: string, value: string) => { salts.set(key, value); } }, STREAM: { send: async (events: unknown[]) => { sent.push(...events); } } };
  return { sqlite, env: env as never, sent };
}

const product = { id: "initech", name: "Initech", domain: "initech.com", collect: "a.initech.com", replay: true, replayDailyCap: 500, currency: "eur" };
const anon = "a_abcdefghijklmnopqrstuv";

describe("signup attribution on return from OAuth", () => {
  it("fills a missing first touch without emitting another signup", async () => {
    const { sqlite, env, sent } = setup();
    const created = new Date(Date.now() - 30_000).toISOString();
    const touch = JSON.stringify({ channel: "Organic Search", at: new Date(Date.now() - 60_000).toISOString() });
    sqlite.prepare("INSERT INTO anon_first (product,anon_id,first_day,first_touch) VALUES (?,?,?,?)").run(product.id, anon, created.slice(0, 10), touch);
    await identify(env, product, { userId: "user", createdAt: created, signup: true });
    expect(sent).toHaveLength(1);
    await identify(env, product, { userId: "user", createdAt: created, attributeSignup: true, seen: { cookie: `csa_id=${anon}` } });
    expect(sqlite.prepare("SELECT first_touch, attribution_method FROM people WHERE user_id='user'").get()).toMatchObject({ first_touch: touch, attribution_method: "cookie" });
    expect(sent).toHaveLength(1);
    sqlite.close();
  });

  it("does not attribute returning users or touches after signup", async () => {
    const { sqlite, env } = setup();
    const now = Date.now();
    const touch = JSON.stringify({ channel: "AI", at: new Date(now).toISOString() });
    sqlite.prepare("INSERT INTO anon_first (product,anon_id,first_day,first_touch) VALUES (?,?,?,?)").run(product.id, anon, new Date(now).toISOString().slice(0, 10), touch);
    for (const [userId, createdAt] of [["returning", now - 86400_000], ["new", now - 60_000]] as const) {
      await identify(env, product, { userId, createdAt: new Date(createdAt).toISOString(), attributeSignup: true, seen: { cookie: `csa_id=${anon}` } });
    }
    expect(sqlite.prepare("SELECT COUNT(*) n FROM people WHERE first_touch IS NOT NULL").get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM identities").get()).toMatchObject({ n: 0 });
    sqlite.close();
  });

  it("never overwrites an existing first touch", async () => {
    const { sqlite, env } = setup();
    const now = Date.now();
    const created = new Date(now - 30_000).toISOString();
    const original = JSON.stringify({ channel: "AI", at: new Date(now - 120_000).toISOString() });
    const later = JSON.stringify({ channel: "Organic Search", at: new Date(now - 60_000).toISOString() });
    sqlite.prepare("INSERT INTO people (product,user_id,created_at,updated_at,first_touch,attribution_method) VALUES (?,?,?,?,?,?)").run(product.id, "user", created, created, original, "hash");
    sqlite.prepare("INSERT INTO anon_first (product,anon_id,first_day,first_touch) VALUES (?,?,?,?)").run(product.id, anon, created.slice(0, 10), later);
    await identify(env, product, { userId: "user", createdAt: created, attributeSignup: true, seen: { cookie: `csa_id=${anon}` } });
    expect(sqlite.prepare("SELECT first_touch, attribution_method FROM people WHERE user_id='user'").get()).toMatchObject({ first_touch: original, attribution_method: "hash" });
    sqlite.close();
  });

  it("links an eligible recent first touch through the temporary hash", async () => {
    const { sqlite, env } = setup();
    const now = Date.now();
    const created = new Date(now - 30_000).toISOString();
    const touch = JSON.stringify({ channel: "AI", at: new Date(now - 60_000).toISOString() });
    const hash = await dayHash(env, product.id, "203.0.113.7", "test-browser", now);
    sqlite.prepare("INSERT INTO recent_visits (product,ident,started_at,touch) VALUES (?,?,?,?)").run(product.id, `h:${hash}`, now - 60_000, touch);
    await identify(env, product, { userId: "user", createdAt: created, attributeSignup: true, seen: { ip: "203.0.113.7", ua: "test-browser" } });
    expect(sqlite.prepare("SELECT first_touch, attribution_method FROM people WHERE user_id='user'").get()).toMatchObject({ first_touch: touch, attribution_method: "hash" });
    sqlite.close();
  });
});
