import { describe, expect, it } from "vitest";
import { bars, buildReport, delta, healthIssues, periodFor, spark } from "../src/report";

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

describe("healthIssues: silent product", () => {
  const history = ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"].map((d) => ({ day: d, views: 100 }));
  const healthEnv = (rows: { day: string; views: number }[], rolledUp: string[]) => {
    const prep = (sql: string) => {
      const s: any = {
        args: [] as unknown[],
        bind(...a: unknown[]) { s.args = a; return s; },
        async all() { return { results: sql.includes("SELECT day, views FROM days") ? rows : [] }; },
        async first() {
          if (sql.includes("job = 'rollup' AND key = ?")) return rolledUp.includes(s.args[0] as string) ? {} : null;
          if (sql.includes("SELECT 1 FROM days")) return {};
          return null;
        },
      };
      return s;
    };
    return { PRODUCTS: JSON.stringify([{ id: "app", name: "App", domain: "app.test", currency: "usd" }]), DB: { prepare: prep } } as never;
  };
  const silent = async (env: never, now: number) => (await healthIssues(env, now)).filter((i) => i.id.startsWith("silent:"));

  it("stays quiet at 00:17 UTC, before yesterday's rollup has run (false alerts of 2026-11-05)", async () => {
    const env = healthEnv(history, ["2026-11-03"]);
    expect(await silent(env, Date.parse("2026-11-05T00:17:00Z"))).toEqual([]);
  });

  it("alerts once yesterday is rolled up and really has no pageview", async () => {
    const env = healthEnv(history, ["2026-11-03", "2026-11-04"]);
    expect((await silent(env, Date.parse("2026-11-05T01:17:00Z"))).map((i) => i.id)).toEqual(["silent:app:2026-11-04"]);
  });

  it("stays quiet when yesterday has pageviews", async () => {
    const env = healthEnv([...history, { day: "2026-11-04", views: 80 }], ["2026-11-03", "2026-11-04"]);
    expect(await silent(env, Date.parse("2026-11-05T01:17:00Z"))).toEqual([]);
  });
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
