import { describe, expect, it } from "vitest";
import { aggregateCrawl, botName, familyOf, kindOf } from "../src/bots";

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
});
