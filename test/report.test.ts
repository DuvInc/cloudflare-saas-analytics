import { describe, expect, it } from "vitest";
import { bars, buildReport, delta, periodFor, spark } from "../src/report";

const day = (d: string, o: Record<string, unknown> = {}) => ({ day: d, views: 40, visitors: 20, visits: 25, bounces: 10, signups: 0, revenue_cents: 0, bot_views: 0, channels: JSON.stringify([{ k: "Direct", visits: 20 }, { k: "Organic Search", visits: 5 }]), ai_sources: "[]", pages: JSON.stringify([{ k: "/", views: 30 }]), ...o });

function env(rows: Record<string, unknown>[]) {
  const prep = (sql: string) => { const s: any = { args: [] as unknown[], bind(...a: unknown[]) { s.args = a; return s; }, async all() { return { results: sql.includes("FROM days WHERE product") ? rows.filter((r) => (r.day as string) >= (s.args[1] as string) && (r.day as string) <= (s.args[2] as string)) : [] }; }, async first() { return null; } }; return s; };
  return { PRODUCTS: JSON.stringify([{ id: "app", name: "App", domain: "app.test", currency: "usd" }]), DB: { prepare: prep } } as never;
}

describe("report helpers", () => {
  it("shows no delta without a previous period", () => { expect(delta(5, 0, false)).toBe(""); expect(delta(5, 0, true)).toBe(""); expect(delta(12, 10, true)).toBe("▲ +20%"); expect(delta(8, 10, true)).toBe("▼ -20%"); expect(delta(10, 10, true)).toBe("· ="); });
  it("scales a sparkline to its maximum", () => { expect(spark([0, 5, 10])).toBe("▁▄█"); expect(spark([0, 0])).toBe("▁▁"); });
  it("draws aligned bars", () => { expect(bars([["Direct", 8], ["AI", 2]], 10)).toContain("████████░░  80%"); });
});

describe("buildReport", () => {
  it("builds Block Kit blocks with no 'new' noise and no empty funnel line", async () => {
    const now = Date.parse("2026-11-02T07:17:00Z");
    const r = await buildReport(env([day("2026-11-01", { signups: 1, revenue_cents: 29700 })]), periodFor("daily", now));
    const json = JSON.stringify(r.blocks);
    expect(r.blocks.length).toBeLessThanOrEqual(50);
    expect(json).not.toContain("(new)");
    expect(json).toContain("297");
    expect(r.text).toContain("Yesterday");
  });
});
