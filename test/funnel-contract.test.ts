import { describe, expect, it } from "vitest";
import catalogs from "../src/catalogs";
import { funnels } from "../src/funnels";
import { computeFunnel } from "../src/journeys";

describe("funnel measurement contracts", () => {
  it("requires unique ids, valid paths and catalogued events for measurable funnels", () => {
    expect(new Set(funnels.map((funnel) => `${funnel.product}:${funnel.id}`)).size).toBe(funnels.length);
    for (const funnel of funnels) {
      expect(funnel.steps.length).toBeGreaterThanOrEqual(2);
      if (funnel.unavailable) { expect(funnel.unavailable.length).toBeGreaterThan(15); continue; }
      for (const step of funnel.steps) {
        if (step.kind === "event") expect(catalogs[funnel.product]?.has(step.value), `${funnel.product}:${step.value}`).toBe(true);
        else for (const pattern of step.paths ?? [step.value]) expect(pattern === "*" || pattern.startsWith("/") || pattern.startsWith("*/")).toBe(true);
      }
    }
  });
  it("matches a page step on every localized path it lists, and not on the listing page", () => {
    const steps = [{ kind: "page" as const, value: "/jobs/*", paths: ["/jobs/*", "/*/jobs/*"] }, { kind: "event" as const, value: "apply_clicked" }];
    for (const path of ["/jobs/analyst", "/fr/jobs/analyst"]) {
      const result = computeFunnel([{ event: "$pageview", path, day_hash: "x", received_at: 1 }, { event: "apply_clicked", day_hash: "x", received_at: 2 }], steps, new Map());
      expect(result.steps.map((step) => step.people)).toEqual([1, 1]);
    }
    expect(computeFunnel([{ event: "$pageview", path: "/jobs", day_hash: "x", received_at: 1 }], steps, new Map()).steps[0]!.people).toBe(0);
  });
});
