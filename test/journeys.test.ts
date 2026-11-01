import { describe, expect, it } from "vitest";
import { computeFunnel } from "../src/journeys";

const t = (m: number) => Date.parse("2026-10-30T10:00:00Z") + m * 60_000;
describe("funnel", () => {
  const alias = new Map([["h:visitor1", "u1"]]);
  const events = [
    { event: "$pageview", path: "/", day_hash: "visitor1", channel: "AI", ai_source: "ChatGPT", received_at: t(0) },
    { event: "$pageview", path: "/pricing", day_hash: "visitor1", received_at: t(2) },
    { event: "signup_completed", user_id: "u1", origin: "server", received_at: t(5) },
    { event: "$pageview", path: "/", day_hash: "visitor2", channel: "Organic Search", received_at: t(1) },
    { event: "signup_completed", user_id: "u2", origin: "server", received_at: t(0) },
    { event: "$pageview", path: "/pricing", day_hash: "visitor3", channel: "Direct", received_at: t(3) },
  ];
  const r = computeFunnel(events, [{ kind: "page", value: "/" }, { kind: "page", value: "/pricing" }, { kind: "event", value: "signup_completed" }], alias);
  it("counts people in order, joining the anonymous visit to the signup", () => {
    expect(r.steps.map((s) => s.people)).toEqual([2, 1, 1]);
    expect(r.steps[2]!.median_ms).toBe(3 * 60_000);
  });
  it("conversion by first channel", () => {
    expect(r.byChannel.find((c) => c.k === "AI · ChatGPT")).toEqual({ k: "AI · ChatGPT", entered: 1, converted: 1 });
    expect(r.byChannel.find((c) => c.k === "Organic Search")).toEqual({ k: "Organic Search", entered: 1, converted: 0 });
  });
});

describe("page steps with stars", () => {
  it("matches a localized workshop page", () => {
    const ev = [
      { event: "$pageview", path: "/fr/workshops/claude-code", day_hash: "x", received_at: t(0) },
      { event: "workshop_interest_submitted", day_hash: "x", received_at: t(1) },
      { event: "$pageview", path: "/workshops", day_hash: "y", received_at: t(0) },
    ];
    const r = computeFunnel(ev, [{ kind: "page", value: "*/workshops/*" }, { kind: "event", value: "workshop_interest_submitted" }], new Map());
    expect(r.steps.map((s) => s.people)).toEqual([1, 1]);
  });
});
