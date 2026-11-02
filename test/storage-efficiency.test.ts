import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ReadContext } from "../src/read-context";
import { compactTodayHours, readLines, rollupDay } from "../src/rollup";
import { filteredDays } from "../src/explore";
import { fakeEnv } from "./fake-env";

const day = "2026-10-29";
const start = Date.parse(`${day}T00:00:00Z`);
const event = (product: string, offset = 0) => ({ product, host: `${product}.example`, event: "$pageview", received_at: start + offset, ts: start + offset, day_hash: product, country: "FR", path: "/", channel: "Direct" });

describe("lossless compacted storage", () => {
  it("reads old concatenated gzip and Brotli without losing Unicode or custom fields", async () => {
    const rows = [{ ...event("one"), props: "été 東京" }, event("two")];
    const { env, objects } = fakeEnv({});
    objects.set("legacy.gz", { bytes: new Uint8Array(Buffer.concat(rows.map(row => gzipSync(JSON.stringify(row) + "\n")))), uploaded: new Date() });
    objects.set("new.br", { bytes: new Uint8Array(brotliCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n")))), uploaded: new Date() });
    expect(await readLines(env, "legacy.gz")).toEqual(rows);
    expect(await readLines(env, "new.br")).toEqual(rows);
  });

  it("writes exact product partitions and excludes unrelated products before fetching", async () => {
    const { env, objects } = fakeEnv({ "raw/sample.gz": { uploaded: start + 120_000, body: [event("one"), event("two", 1000)].map(row => JSON.stringify(row)).join("\n") } });
    const result = await rollupDay(env, day);
    expect(result.files).toEqual([`daily/${day}/product=one/part-000.ndjson.br`, `daily/${day}/product=two/part-000.ndjson.br`]);
    const rows = (await Promise.all(result.files.map(key => readLines(env, key)))).flat();
    expect(rows.map(row => row.product).sort()).toEqual(["one", "two"]);
    expect(rows.every(row => row.visit_id)).toBe(true);
    const fixture = fakeEnv({}, [{ key: day, ran_at: "v1", files: JSON.stringify(result.files) }]);
    for (const key of result.files) fixture.objects.set(key, objects.get(key)!);
    const context = new ReadContext(fixture.env);
    const get = vi.spyOn(context.env.BUCKET, "get");
    const selected = await context.day(day, "2026-11-02", "one");
    expect(selected.map(row => row.product)).toEqual(["one"]);
    expect(get.mock.calls.map(call => call[0])).toEqual([result.files[0]]);
    expect((await new ReadContext(fixture.env).day(day, "2026-11-02")).length).toBe(2);
    const filters = await filteredDays(fixture.env, "one", "*", day, 1, [{ dim: "country", value: "FR" }]);
    expect(filters[0]!.views).toBe(1);
  });

  it("keeps legacy mixed manifests readable with a product selection", async () => {
    const key = `daily/${day}/part-000.ndjson.gz`;
    const { env } = fakeEnv({ [key]: { uploaded: start + 86400_000, body: [event("one"), event("two")].map(row => JSON.stringify(row)).join("\n") } }, [{ key: day, ran_at: "old", files: JSON.stringify([key]) }]);
    const rows = await new ReadContext(env).day(day, "2026-11-02", "one");
    expect(rows.map(row => row.product)).toEqual(["one"]);
  });

  it("does not expose unpublished partitions after an interrupted rollup", async () => {
    const { env, objects } = fakeEnv({ "raw/all.gz": { uploaded: start + 60_000, body: [event("one"), event("two")].map(row => JSON.stringify(row)).join("\n") } });
    objects.set(`daily/${day}/product=one/part-000.ndjson.br`, { bytes: new Uint8Array(brotliCompressSync(Buffer.from(JSON.stringify(event("one"))))), uploaded: new Date() });
    const rows = await new ReadContext(env).day(day, "2026-11-02");
    expect(rows.map(row => row.product).sort()).toEqual(["one", "two"]);
  });

  it("fails rather than silently dropping a missing committed part", async () => {
    const fixture = fakeEnv({}, [{ key: day, ran_at: "v1", files: JSON.stringify([`daily/${day}/product=one/missing.ndjson.br`]) }]);
    await expect(new ReadContext(fixture.env).day(day, "2026-11-02", "one")).rejects.toThrow("Missing compacted object");
  });

  it("mixes existing gzip hours with new Brotli hours and preserves the live tail", async () => {
    const now = start + 3 * 3600_000 + 45 * 60_000;
    const oldKey = `cache/hours/${day}/00.ndjson.gz`;
    const hourOne = event("one", 3600_000);
    const tail = event("one", 3 * 3600_000);
    const { env, objects } = fakeEnv({
      [oldKey]: { uploaded: start + 3600_000, body: JSON.stringify(event("one")) },
      "raw/hour-one.gz": { uploaded: start + 3600_000 + 60_000, body: JSON.stringify(hourOne) },
      "raw/tail.gz": { uploaded: now - 60_000, body: JSON.stringify(tail) },
    });
    const original = objects.get(oldKey)!.bytes;
    expect(await compactTodayHours(env, now)).toBe(2);
    expect(objects.get(oldKey)!.bytes).toEqual(original);
    expect(objects.has(`cache/hours/${day}/00.ndjson.br`)).toBe(false);
    expect(objects.has(`cache/hours/${day}/01.ndjson.br`)).toBe(true);
    expect(await compactTodayHours(env, now)).toBe(0);
    const rows = await new ReadContext(env).day(day, day);
    expect(rows.map(row => row.received_at).sort()).toEqual([start, hourOne.received_at, tail.received_at].sort());
  });
});
