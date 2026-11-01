import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { identify, reconcileSignups } from "../src/rpc";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => sqlite.prepare(sql).get(...args as never[]) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args as never[]) }),
    run: async () => sqlite.prepare(sql).run(...args as never[]),
  });
  const sent: any[] = [];
  const env = { DB: { prepare: stmt, batch: async (l: ReturnType<typeof stmt>[]) => Promise.all(l.map((s) => s.run())) }, KV: { get: async () => null, put: async () => {} }, STREAM: { send: async (e: unknown[]) => { sent.push(...e); } } };
  return { sqlite, env: env as never, sent };
}
const product = { id: "initech", name: "Initech", domain: "initech.com", collect: "a.initech.com", replay: true, replayDailyCap: 500, currency: "eur" };
const signups = (sent: any[]) => sent.filter((e) => e.event === "signup_completed");

describe("one sign-up per person", () => {
  it("counts a Google sign-in that only reports a login, once even if the webhook follows", async () => {
    const { env, sent } = setup();
    const created = new Date(Date.now() - 20_000).toISOString();
    await identify(env, product, { userId: "u", createdAt: created, attributeSignup: true });
    await identify(env, product, { userId: "u", createdAt: created, signup: true });
    await identify(env, product, { userId: "u", createdAt: created, attributeSignup: true });
    expect(signups(sent)).toHaveLength(1);
  });
  it("does not count an old account that logs in", async () => {
    const { env, sent } = setup();
    await identify(env, product, { userId: "old", createdAt: new Date(Date.now() - 86400_000).toISOString(), attributeSignup: true });
    expect(signups(sent)).toHaveLength(0);
  });
  it("reconciles an account nobody counted, with its creation time", async () => {
    const { sqlite, env, sent } = setup();
    const created = new Date(Date.now() - 3600_000).toISOString();
    sqlite.prepare("INSERT INTO people (product,user_id,created_at,updated_at) VALUES (?,?,?,?)").run(product.id, "late", created, created);
    expect(await reconcileSignups(env, [product])).toBe(1);
    expect(await reconcileSignups(env, [product])).toBe(0);
    expect(signups(sent)[0].ts).toBe(Date.parse(created));
  });
});
