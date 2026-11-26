import { describe, expect, it, vi } from "vitest";
import { aggregateCrawl, botName, botSites, familyOf, kindOf, missingBotSites, rollupBotDay, runBots } from "../src/bots";
import type { Env } from "../src/env";
import { fakeEnv } from "./fake-env";

describe("bots", () => {
  it("families: name first, Cloudflare category as fallback", () => {
    expect(familyOf("ChatGPT-User", "AI Assistant")).toBe("answers");
    expect(familyOf("Perplexity-User", "")).toBe("answers");
    expect(familyOf("OAI-SearchBot", "AI Search")).toBe("ai_search");
    expect(familyOf("GPTBot", "AI Crawler")).toBe("ai_training");
    expect(familyOf("meta-externalagent", "AI Crawler")).toBe("ai_training");
    expect(familyOf("Googlebot", "Search Engine Crawler")).toBe("search");
    expect(familyOf("facebookexternalhit", "Page Preview")).toBe("preview");
    expect(familyOf("NewThingBot", "AI Assistant")).toBe("answers");
    expect(familyOf("Whatever", "Monitoring & Analytics")).toBe("other");
  });
  it("kinds and names", () => {
    expect(kindOf("/llms.txt")).toBe("llms");
    expect(kindOf("/fr/pricing.md")).toBe("twin");
    expect(kindOf("/pricing")).toBe("page");
    expect(botName("Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot")).toBe("ChatGPT-User");
  });
  it("aggregates a day by bot, pages without assets", () => {
    const rows = [
      { bot_name: "GPTBot", bot_category: "AI Crawler", path: "/", kind: "page", status: 200, country: "US", host: "a.com", requests: 3 },
      { bot_name: "GPTBot", bot_category: "AI Crawler", path: "/x.png", kind: "asset", status: 404, country: "US", host: "a.com", requests: 2 },
      { bot_name: "ChatGPT-User", bot_category: "AI Assistant", path: "/pricing", kind: "page", status: 200, country: "US", host: "a.com", requests: 1 },
    ];
    const a = aggregateCrawl(rows);
    const g = a.find((x) => x.bot === "GPTBot")!;
    expect(g.requests).toBe(5);
    expect(g.errors).toBe(2);
    expect(g.pages).toEqual([{ k: "/", n: 3 }]);
    expect(g.kinds).toEqual({ page: 3, asset: 2 });
  });

  it("counts only 404 document responses and keeps identical paths on different hosts apart", () => {
    const rows = [
      { host: "docs.example", path: "/old.md", status: 404, requests: 4 },
      { host: "docs.example", path: "/old.md", status: 404, requests: 2 },
      { host: "docs.example", path: "/old.md", status: 200, requests: 50 },
      { host: "app.example", path: "/old.md", status: 404, requests: 3 },
      { host: "docs.example", path: "/llms.txt", status: 404, requests: 2 },
      { host: "docs.example", path: "/old", status: 403, requests: 8 },
      { host: "docs.example", path: "/old.png", status: 404, requests: 9 },
    ];
    expect(aggregateCrawl(rows)[0]?.notFound).toEqual({
      pages: [
        { host: "docs.example", path: "/old.md", requests: 6 },
        { host: "app.example", path: "/old.md", requests: 3 },
        { host: "docs.example", path: "/llms.txt", requests: 2 },
      ],
      truncated: false,
    });
  });

  it("marks a closed day partial until all hours exist and reports only the due hour per zone", async () => {
    const { env: fixtures, objects } = fakeEnv({});
    const runs = new Map<string, { key: string; status: string; note: string }>();
    const env = {
      ...(fixtures as Env),
      PRODUCTS: [{ id: "test", domain: "test.example", name: "Test", collect: "t.test.example" }],
      BOTS: { since: "2026-11-13T22" },
      CF_ANALYTICS_TOKEN: "mock-token",
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: string[]) {
              return {
                async all() {
                  const results = [...runs.values()];
                  return { results: sql.includes("key IN") ? results.filter((r) => args.includes(r.key) && r.status === "ok") : results };
                },
                async run() {
                  const [, key, status, , note] = args;
                  runs.set(key!, { key: key!, status: status!, note: note! });
                },
              };
            },
          };
        },
        async batch() { return []; },
      },
    } as unknown as Env;
    let unavailable = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/zones?")) return Response.json({ success: true, result: [{ id: "zone", name: "test.example" }] });
      const { variables } = JSON.parse(String(init?.body));
      const missing = unavailable && variables.since === "2026-11-13T23:00:00.000Z";
      return Response.json({ data: { viewer: { zones: missing ? [] : [{ httpRequestsAdaptiveGroups: [] }] } } });
    });
    const now = Date.parse("2026-11-14T01:17:00Z");
    try {
      await runBots(env, now);
      expect(runs.get("test.example|2026-11-13|day")).toBeUndefined();
      await runBots(env, Date.parse("2026-11-14T02:17:00Z"));
      expect(runs.get("test.example|2026-11-13|day")).toMatchObject({ status: "partial", note: "1/2 hours collected" });
      expect(objects.has("bots/test.example/crawl/2026-11-13/23.ndjson.gz")).toBe(false);
      expect(await missingBotSites(env, botSites(env), Date.parse("2026-11-14T00:23:00Z"))).toMatchObject([{ hour: "2026-11-13T23" }]);
      unavailable = false;
      await runBots(env, Date.parse("2026-11-14T04:17:00Z"));
      expect(runs.get("test.example|2026-11-13|day")).toMatchObject({ status: "ok", note: "2/2 hours collected" });
      expect(await missingBotSites(env, botSites(env), Date.parse("2026-11-14T00:23:00Z"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("joins the original and new zones on the switch day without double-counting overlap", async () => {
    const day = "2026-11-13";
    const raw = (hour: string, count: number) => ({
      body: JSON.stringify({ hour: `${day}T${hour}`, bot_name: "GPTBot", path: "/", requests: count }),
      uploaded: Date.parse(`${day}T${hour}:00:00Z`),
    });
    const { env, statements } = fakeEnv({
      [`bots/old-acme.app/crawl/${day}/09.ndjson.gz`]: raw("09", 3),
      [`bots/acme.com/crawl/${day}/09.ndjson.gz`]: raw("09", 100),
      [`bots/old-acme.app/crawl/${day}/10.ndjson.gz`]: raw("10", 100),
      [`bots/acme.com/crawl/${day}/10.ndjson.gz`]: raw("10", 5),
    });
    await rollupBotDay(env, { id: "acme", name: "Acme", zone: "acme.com" }, day, { previousZone: "old-acme.app", switchHour: `${day}T10` });
    const write = statements.find(({ sql }) => sql.startsWith("INSERT INTO bot_days"));
    expect(write?.args.slice(0, 5)).toEqual(["acme", day, "GPTBot", "", 8]);
  });
});
