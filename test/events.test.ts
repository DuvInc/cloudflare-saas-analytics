import { describe, expect, it } from "vitest";
import { cleanProps, eventName } from "../src/events";

describe("events", () => {
  it("names", () => {
    expect(eventName("checkout_started")).toBe("checkout_started");
    expect(eventName("$pageview")).toBe("$pageview");
    expect(eventName("CheckoutStarted")).toBe("");
    expect(eventName("$identify")).toBe("");
  });
  it("props drop content and contact details", () => {
    expect(JSON.parse(cleanProps({ plan: "pro", email: "x@y.z", prompt: "secret", seats: 3, nested: { a: 1 } })!)).toEqual({ plan: "pro", seats: 3 });
    expect(cleanProps({ email: "x" })).toBeNull();
  });
});
