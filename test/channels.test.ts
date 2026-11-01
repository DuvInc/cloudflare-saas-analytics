import { describe, expect, it } from "vitest";
import { classify } from "../src/channels";

const page = "https://acme.com/pricing";
describe("classify", () => {
  it("ChatGPT by utm_source even without referrer", () => {
    const t = classify(`${page}?utm_source=chatgpt.com`, "", "acme.com");
    expect([t.channel, t.ai_source]).toEqual(["AI", "ChatGPT"]);
  });
  it("AI by referrer host", () => {
    expect(classify(page, "https://www.perplexity.ai/search?q=x", "acme.com").ai_source).toBe("Perplexity");
    expect(classify(page, "https://claude.ai/chat/1", "acme.com").ai_source).toBe("Claude");
    expect(classify(page, "https://gemini.google.com/app", "acme.com").ai_source).toBe("Gemini");
  });
  it("Gemini is AI, Google is search", () => {
    expect(classify(page, "https://www.google.de/", "acme.com").channel).toBe("Organic Search");
  });
  it("paid beats everything", () => {
    expect(classify(`${page}?gclid=abc`, "https://www.google.com/", "acme.com").channel).toBe("Paid Search");
    expect(classify(`${page}?utm_source=chatgpt&utm_medium=cpc`, "", "acme.com").channel).toBe("Paid Other");
  });
  it("internal navigation and subdomains", () => {
    const t = classify("https://app.acme.com/", "https://acme.com/pricing", "acme.com");
    expect(t.channel).toBe("Internal");
    expect(t.referrer_host).toBe("");
  });
  it("social, video, email, referral, direct", () => {
    expect(classify(page, "https://www.linkedin.com/feed/", "acme.com").channel).toBe("Organic Social");
    expect(classify(page, "https://www.youtube.com/watch?v=1", "acme.com").channel).toBe("Organic Video");
    expect(classify(`${page}?utm_medium=email`, "", "acme.com").channel).toBe("Email");
    expect(classify(page, "https://someblog.dev/post", "acme.com").channel).toBe("Referral");
    expect(classify(page, "", "acme.com").channel).toBe("Direct");
  });
});
