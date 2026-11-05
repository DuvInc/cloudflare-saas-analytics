import { describe, expect, it } from "vitest";
import { botLogo } from "../web/src/lib/bot-icon";

describe("bot logos", () => {
  it.each(["Googlebot", "bingbot", "AhrefsBot", "SemrushBot", "Amazonbot", "meta-externalagent", "facebookexternalhit", "OAI-SearchBot", "ClaudeBot", "LinkupBot", "LookioBot", "Baiduspider", "DataForSeoBot", "YouBot"])("uses a local image for %s", (name) => {
    expect(botLogo(name)).toMatch(/^data:image\/(png|jpeg);base64,/);
  });

  it("falls back for unknown bots", () => {
    expect(botLogo("unknownbot")).toBeUndefined();
  });
});
