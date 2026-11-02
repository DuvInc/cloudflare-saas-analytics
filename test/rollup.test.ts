import { describe, expect, it } from "vitest";
import { rollupDay } from "../src/rollup";
import { fakeEnv } from "./fake-env";

const day = "2026-10-29";
const at = (h: number, m = 0) => Date.parse(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
const line = (o: Record<string, unknown>) => JSON.stringify({ product: "acme", host: "acme.com", ts: o.received_at, path: "/", channel: "Direct", country: "DE", ...o });

describe("rollupDay", () => {
  it("keeps only events received that day, compacts them and writes the day's rows", async () => {
    const { env, objects, statements } = fakeEnv({
      "raw/a.json.gz": { uploaded: at(10, 5), body: [line({ event: "$pageview", received_at: at(10), day_hash: "h1", channel: "AI", ai_source: "ChatGPT" }), line({ event: "$pageview", received_at: at(10, 1), day_hash: "h1", path: "/pricing" })].join("\n") },
      "raw/b.json.gz": { uploaded: Date.parse("2026-10-30T00:03:00Z"), body: [line({ event: "$pageview", received_at: at(23, 59), day_hash: "h2" }), line({ event: "$pageview", received_at: Date.parse("2026-10-30T00:01:00Z"), day_hash: "h3" })].join("\n") },
      "raw/old.json.gz": { uploaded: Date.parse("2026-10-27T12:00:00Z"), body: line({ event: "$pageview", received_at: Date.parse("2026-10-27T11:00:00Z"), day_hash: "x" }) },
    });
    const r = await rollupDay(env, day);
    expect(r.events).toBe(3);
    expect(r.files).toEqual([`daily/${day}/product=acme/part-000.ndjson.br`]);
    expect(objects.has(`daily/${day}/product=acme/part-000.ndjson.br`)).toBe(true);
    const insert = statements.find((s) => s.sql.includes("INSERT OR REPLACE INTO days") && s.args[1] === "*")!;
    expect(insert.args.slice(0, 6)).toEqual(["acme", "*", day, 3, 2, 2]); // views, visitors, visits
    expect(JSON.parse(insert.args[17] as string)).toEqual([{ k: "ChatGPT", views: 0, visits: 1, visitors: 1 }]);
  });
});
