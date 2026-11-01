import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadContext } from "../src/read-context";
import { filteredDays } from "../src/explore";
import { fakeEnv } from "./fake-env";

afterEach(() => vi.useRealTimers());
const day = "2026-10-30";
const now = Date.parse(`${day}T12:00:00Z`);
const event = (country = "DE") => JSON.stringify({ product: "p", host: "p.com", event: "$pageview", received_at: now - 1000, ts: now - 1000, day_hash: "a", path: "/", country });

describe("bounded read contexts", () => {
  it("does not extend source freshness by caching a derived answer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { env } = fakeEnv({});
    await new ReadContext(env).cached("source", async () => 1);
    vi.setSystemTime(119_000);
    const derived = new ReadContext(env);
    expect(await derived.cached("answer", () => derived.cached("source", async () => 2))).toBe(1);
    vi.setSystemTime(120_001);
    const next = new ReadContext(env);
    expect(await next.cached("answer", () => next.cached("source", async () => 2))).toBe(2);
  });
  it("shares in-flight work within a request, completed values between requests, never errors", async () => {
    const { env } = fakeEnv({});
    const first = new ReadContext(env);
    const loader = vi.fn(async () => 42);
    expect(await Promise.all([first.cached("k", loader), first.cached("k", loader)])).toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await new ReadContext(env).cached("k", loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    const failing = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(7);
    await expect(first.cached("fail", failing)).rejects.toThrow("offline");
    expect(await first.cached("fail", failing)).toBe(7);
  });

  it("expires, refreshes, and isolates buckets", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { env } = fakeEnv({});
    let count = 0;
    const load = async () => ++count;
    expect(await new ReadContext(env).cached("k", load)).toBe(1);
    expect(await new ReadContext(env).cached("k", load)).toBe(1);
    const fresh = new ReadContext(env, true);
    expect(await fresh.cached("k", load)).toBe(2);
    expect(await fresh.cached("k", load)).toBe(2);
    vi.setSystemTime(now + 120_001);
    expect(await new ReadContext(env).cached("k", load)).toBe(3);
    expect(await new ReadContext(fakeEnv({}).env).cached("k", load)).toBe(4);
  });

  it("does not share promises between requests", async () => {
    const { env } = fakeEnv({});
    let resolve!: (value: number) => void;
    const waiting = new ReadContext(env).cached("k", () => new Promise<number>((done) => { resolve = done; }));
    expect(await new ReadContext(env).cached("k", async () => 2)).toBe(2);
    resolve(1); expect(await waiting).toBe(1);
    expect(await new ReadContext(env).cached("k", async () => 3)).toBe(2);
  });

  it("evicts by weight and does not retain oversized values", async () => {
    const context = new ReadContext(fakeEnv({}).env);
    const load = vi.fn(async () => 1);
    await context.cached("a", load, () => 10 * 1024 * 1024);
    await context.cached("b", load, () => 10 * 1024 * 1024);
    await context.cached("a", load, () => 10 * 1024 * 1024);
    expect(load).toHaveBeenCalledTimes(3);
    await context.cached("huge", load, () => 17 * 1024 * 1024);
    await context.cached("huge", load, () => 17 * 1024 * 1024);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("reads the manifest directly and copies events before sessionization", async () => {
    const key = `daily/${day}/part-000.ndjson.gz`;
    const { env } = fakeEnv({ [key]: { body: event(), uploaded: now } }, [{ key: day, ran_at: "v1", files: JSON.stringify([key]) }]);
    const bucket = (env as any).BUCKET;
    const list = vi.spyOn(bucket, "list");
    const get = vi.spyOn(bucket, "get");
    const context = new ReadContext(env);
    const first = await context.day(day, "2026-10-31");
    first[0]!.visit_id = "mutated";
    expect((await context.day(day, "2026-10-31"))[0]!.visit_id).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not persist open days and sees new raw files on explicit refresh", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { env, objects } = fakeEnv({ "raw/one.gz": { body: event(), uploaded: now } });
    const filters = [{ dim: "country" as const, value: "DE" }];
    expect((await filteredDays(env, "p", "*", day, 1, filters))[0]!.views).toBe(1);
    const extra = fakeEnv({ "raw/two.gz": { body: event(), uploaded: now } });
    objects.set("raw/two.gz", extra.objects.get("raw/two.gz")!);
    expect((await filteredDays(env, "p", "*", day, 1, filters))[0]!.views).toBe(1);
    expect((await filteredDays(env, "p", "*", day, 1, filters, new ReadContext(env, true)))[0]!.views).toBe(2);
    expect([...objects.keys()].some((key) => key.startsWith("cache/"))).toBe(false);
  });

  it("invalidates both result and file caches after a rollup revision", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now + 86400_000);
    const key = `daily/${day}/part-000.ndjson.gz`;
    const manifest = { key: day, ran_at: "v1", files: JSON.stringify([key]) };
    const { env, objects } = fakeEnv({ [key]: { body: event(), uploaded: now } }, [manifest]);
    const filters = [{ dim: "country" as const, value: "DE" }];
    expect((await filteredDays(env, "p", "*", day, 1, filters))[0]!.views).toBe(1);
    objects.set(key, fakeEnv({ [key]: { body: event("FR"), uploaded: now } }).objects.get(key)!);
    manifest.ran_at = "v2";
    expect(await filteredDays(env, "p", "*", day, 1, filters)).toEqual([]);
  });
});
