import { describe, expect, it } from "vitest";
import { sessionize } from "../src/aggregate";
import { matches } from "../src/explore";

const t0 = Date.parse("2026-10-30T10:00:00Z");
const ev = (o: Record<string, unknown>) => ({ product: "p", host: "p.com", ts: 0, ...o });

describe("filters match whole visits", () => {
  const events = [
    ev({ event: "$pageview", received_at: t0, day_hash: "a", path: "/", channel: "AI", ai_source: "ChatGPT", country: "FR" }),
    ev({ event: "$pageview", received_at: t0 + 60_000, day_hash: "a", path: "/pricing", channel: "Internal", country: "FR" }),
    ev({ event: "$pageview", received_at: t0, day_hash: "b", path: "/blog", channel: "Organic Search", country: "DE" }),
  ];
  const visits = sessionize(events);
  const of = (id: string) => events.filter((e: any) => e.visit_id === id);
  const a = visits.find((v) => v.ident === "h:a")!;
  const b = visits.find((v) => v.ident === "h:b")!;

  it("channel is the entry's, not each page's", () => {
    expect(matches({ dim: "channel", value: "AI" }, a, of(a.id))).toBe(true);
    expect(matches({ dim: "channel", value: "Internal" }, a, of(a.id))).toBe(false);
    expect(matches({ dim: "ai", value: "ChatGPT" }, a, of(a.id))).toBe(true);
  });
  it("page keeps visits that saw it, entry only those that landed on it", () => {
    expect(matches({ dim: "page", value: "/pricing" }, a, of(a.id))).toBe(true);
    expect(matches({ dim: "entry", value: "/pricing" }, a, of(a.id))).toBe(false);
    expect(matches({ dim: "page", value: "/pricing" }, b, of(b.id))).toBe(false);
  });
  it("country", () => {
    expect(matches({ dim: "country", value: "DE" }, b, of(b.id))).toBe(true);
    expect(matches({ dim: "country", value: "DE" }, a, of(a.id))).toBe(false);
  });
});

import { vi } from "vitest";
import { filteredDays } from "../src/explore";
import { fakeEnv } from "./fake-env";

describe("filteredDays reads compacted files and keeps matching visits", () => {
  it("channel filter on a closed day", async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const day = "2026-10-20";
    const t = (m: number) => Date.parse(`${day}T10:00:00Z`) + m * 60_000;
    const line = (o: Record<string, unknown>) => JSON.stringify({ product: "p", host: "p.com", ts: 0, ...o });
    const body = [
      line({ event: "$pageview", received_at: t(0), day_hash: "a", path: "/", channel: "AI", ai_source: "ChatGPT", country: "FR" }),
      line({ event: "$pageview", received_at: t(1), day_hash: "a", path: "/pricing", channel: "Internal", country: "FR" }),
      line({ event: "$pageview", received_at: t(0), day_hash: "b", path: "/blog", channel: "Organic Search", country: "DE" }),
      line({ event: "$pageview", received_at: t(0), day_hash: "c", path: "/", channel: "AI", ai_source: "Claude", product: "other" }),
    ].join("\n");
    const key = `daily/${day}/part-000.ndjson.gz`;
    const { env, objects } = fakeEnv({ [key]: { body, uploaded: t(60) } }, [{ key: day, ran_at: "2026-10-21T01:00:00Z", files: JSON.stringify([key]) }]);
    const rows = await filteredDays(env, "p", "*", day, 1, [{ dim: "channel", value: "AI" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.views).toBe(2);
    expect(rows[0]!.visitors).toBe(1);
    expect(JSON.parse(rows[0]!.pages).map((x: { k: string }) => x.k).sort()).toEqual(["/", "/pricing"]);
    // the closed day is cached in R2: a second call reads it back
    expect([...objects.keys()].some((k) => k.startsWith("cache/explore/v2/"))).toBe(true);
    expect((await filteredDays(env, "p", "*", day, 1, [{ dim: "channel", value: "AI" }]))[0]!.views).toBe(2);
    vi.unstubAllGlobals();
  });
});
