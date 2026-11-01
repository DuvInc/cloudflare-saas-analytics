import { describe, expect, it } from "vitest";
import { isCrawlerUA, parseUA } from "../src/ua";

describe("ua", () => {
  it("families", () => {
    expect(parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"))
      .toMatchObject({ device: "mobile", browser: "Safari", browser_major: 18, os: "iOS", os_major: 18 });
    expect(parseUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"))
      .toMatchObject({ device: "desktop", browser: "Edge", os: "Windows" });
    expect(parseUA("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"))
      .toMatchObject({ device: "mobile", browser: "Chrome", os: "Android" });
  });
  it("crawlers", () => {
    expect(isCrawlerUA("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toBe(true);
    expect(isCrawlerUA("curl/8.4.0")).toBe(true);
    expect(isCrawlerUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36")).toBe(true);
    expect(isCrawlerUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe(false);
  });
});
