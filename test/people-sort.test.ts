import { describe, expect, it } from "vitest";
import { peopleOrder } from "../src/operator/people-sort";

describe("people ordering", () => {
  it("uses the default order for missing or unrecognised input", () => {
    expect(peopleOrder(null)).toBe("created_at DESC, product ASC, user_id ASC");
    expect(peopleOrder("user; DROP TABLE people")).toBe(peopleOrder(null));
    expect(peopleOrder("toString")).toBe(peopleOrder(null));
  });

  it("sorts supported columns in both directions, with nulls last", () => {
    for (const key of ["user", "product", "origin", "country", "plan", "replays", "last_seen"]) {
      expect(peopleOrder(key)).toContain("IS NULL) ASC");
      expect(peopleOrder(key)).toContain("COLLATE NOCASE ASC");
      expect(peopleOrder(`-${key}`)).toContain("COLLATE NOCASE DESC");
    }
  });
});
