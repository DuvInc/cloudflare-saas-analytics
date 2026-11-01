import { describe, expect, it } from "vitest";
import { aggregate, sessionize } from "../src/aggregate";

const T0 = Date.parse("2026-10-30T10:00:00Z");
const ev = (o: Record<string, unknown>) => ({ product: "a", host: "a.com", received_at: T0, ts: T0, path: "/", channel: "Direct", country: "DE", device: "desktop", browser: "Chrome", os: "macOS", ...o });

describe("sessionize + aggregate", () => {
  it("one visitor, two visits split by a 30 min gap, signup folds the hash into the user", () => {
    const events = [
      ev({ event: "$pageview", day_hash: "h1", channel: "AI", ai_source: "ChatGPT", referrer_host: "chatgpt.com", path: "/pricing" }),
      ev({ event: "$pageleave", day_hash: "h1", engaged_ms: 40_000, received_at: T0 + 40_000 }),
      ev({ event: "$pageview", day_hash: "h1", user_id: "u1", host: "app.a.com", path: "/", received_at: T0 + 60_000, channel: "Internal" }),
      ev({ event: "signup_completed", user_id: "u1", host: "", received_at: T0 + 61_000 }),
      ev({ event: "$pageview", day_hash: "h1", received_at: T0 + 3 * 3600_000, channel: "Direct", path: "/blog" }),
    ];
    const visits = sessionize(events);
    expect(visits.length).toBe(2);
    expect(visits[0]!.ident).toBe("u:u1");
    const all = aggregate("2026-10-30", events, visits, new Set()).find((r) => r.host === "*")!;
    expect(all.visitors).toBe(1);
    expect(all.visits).toBe(2);
    expect(all.views).toBe(3);
    expect(all.signups).toBe(1);
    expect(all.bounces).toBe(1);
    expect(all.channels.find((c) => c.k === "AI")?.visits).toBe(1);
    expect(all.ai_sources[0]).toMatchObject({ k: "ChatGPT", visits: 1 });
    expect(all.entries.map((e) => e.k).sort()).toEqual(["/blog", "/pricing"]);
  });
  it("bots are counted apart and never form visits", () => {
    const events = [ev({ event: "$pageview", is_bot: true, day_hash: null }), ev({ event: "$pageview", day_hash: "h2" })];
    const visits = sessionize(events);
    const all = aggregate("2026-10-30", events, visits, new Set()).find((r) => r.host === "*")!;
    expect([all.views, all.bot_views, all.visits]).toEqual([1, 1, 1]);
  });
  it("page views with no identity (Do Not Track) are views, not visitors", () => {
    const events = [ev({ event: "$pageview" }), ev({ event: "$pageview", received_at: T0 + 1000 }), ev({ event: "$pageview", day_hash: "h9", received_at: T0 + 2000 })];
    const all = aggregate("2026-10-30", events, sessionize(events), new Set()).find((r) => r.host === "*")!;
    expect([all.views, all.visitors]).toEqual([3, 1]);
  });
  it("returning visitors come from cookies first seen earlier", () => {
    const events = [ev({ event: "$pageview", anon_id: "a_old" }), ev({ event: "$pageview", anon_id: "a_new", received_at: T0 + 1 })];
    const all = aggregate("2026-10-30", events, sessionize(events), new Set(["a_old"])).find((r) => r.host === "*")!;
    expect(all.visitors).toBe(2);
    expect(all.returning).toBe(1);
  });
});
