import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { chunkDelivery, KEEPALIVE_LIMIT, type Answer } from "../client/replay-delivery";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m }; };
type Call = { url: string; keepalive: boolean; events: unknown[]; token: string };
function harness(respond: (call: Call) => Promise<Response> = async () => new Response(null, { status: 204 }), store = memory()) {
  const calls: Call[] = []; const answers: Array<[Answer, string]> = [];
  const send = ((url: string, init: RequestInit) => {
    const body = init.body as Uint8Array;
    const nl = body.indexOf(0x0a);
    const call = { url, keepalive: !!init.keepalive, token: new TextDecoder().decode(body.subarray(0, nl)), events: JSON.parse(gunzipSync(body.subarray(nl + 1)).toString()) };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  const delivery = chunkDelivery({ endpoint: "https://t.x/r", store, send, token: () => "u1.tok", onAnswer: (a, s) => answers.push([a, s]) });
  return { calls, answers, delivery, store };
}
const chunk = (q = "s=rs_a&q=0", events: unknown[] = [{ type: 3, timestamp: 1 }]) => ({ session: "rs_a", query: q, events });
const tick = () => new Promise((r) => setTimeout(r, 5));
const dead = () => new Promise<Response>(() => {});

describe("replay chunk delivery", () => {
  it("sends before returning when the page is leaving: nothing to await", () => {
    const { calls, delivery } = harness();
    delivery.sendNow([chunk()]);
    expect(calls).toHaveLength(1); // synchronously
    expect(calls[0]).toMatchObject({ keepalive: true, token: "u1.tok", url: "https://t.x/r?s=rs_a&q=0" });
    expect(calls[0].events).toEqual([{ type: 3, timestamp: 1 }]);
  });

  it("resends after a redirect a chunk that was never answered, with the original seq", async () => {
    const store = memory();
    harness(dead, store).delivery.sendNow([chunk()]); // the page died on the way to Stripe
    const back = harness(undefined, store);
    await back.delivery.drain();
    expect(back.calls.map((c) => c.url)).toEqual(["https://t.x/r?s=rs_a&q=0"]);
    expect(store.m.size).toBe(0);
    await back.delivery.drain();
    expect(back.calls).toHaveLength(1);
  });

  it("forgets a chunk once the server answered", async () => {
    const { delivery, store } = harness();
    delivery.sendNow([chunk()]);
    await tick();
    expect(store.m.size).toBe(0);
  });

  it("rescues a chunk still being compressed when the page starts leaving", async () => {
    const { calls, delivery } = harness();
    const pending = delivery.send(chunk("s=rs_a&q=4"));
    delivery.sendNow([chunk("s=rs_a&q=5")]);
    expect(calls.map((c) => c.url.split("q=")[1])).toEqual(["4", "5"]);
    await pending;
    expect(calls).toHaveLength(2); // not posted a second time
  });

  it("uses keepalive only within the browser's allowance, and keeps what does not fit", () => {
    const noise = Array.from({ length: 6000 }, (_, i) => ({ type: 3, timestamp: i, r: Math.random().toString(36) + Math.random().toString(36) }));
    const { calls, delivery, store } = harness(dead);
    delivery.sendNow([chunk("s=rs_a&q=0", noise), chunk("s=rs_a&q=1")]);
    expect(calls[0].keepalive).toBe(false);
    expect(calls[1].keepalive).toBe(true);
    expect(JSON.parse(store.m.get("csa_rs_pending")!)).toHaveLength(2);
    expect(KEEPALIVE_LIMIT).toBeLessThanOrEqual(64 * 1024);
  });

  it("reports what the server says about a live chunk", async () => {
    const statuses: Array<[number, Answer, string?]> = [[204, "ok"], [200, "stop", '{"stop":true}'], [200, "ok", "{}"], [401, "unauthorized"], [403, "refused"], [500, "failed"]];
    for (const [status, expected, body] of statuses) {
      const { answers, delivery } = harness(async () => new Response(body ?? null, { status }));
      await delivery.send(chunk());
      expect(answers).toEqual([[expected, "rs_a"]]);
    }
  });

  it("keeps a chunk through a server error, drops one the server rejects, stops when offline", async () => {
    const store = memory();
    harness(dead, store).delivery.sendNow([chunk("s=rs_a&q=0"), chunk("s=rs_a&q=1")]);
    await harness(async () => new Response(null, { status: 503 }), store).delivery.drain();
    expect(JSON.parse(store.m.get("csa_rs_pending")!)).toHaveLength(2);
    const offline = harness(async () => { throw new Error("offline"); }, store);
    await offline.delivery.drain();
    expect(offline.calls).toHaveLength(1);
    await harness(async () => new Response(null, { status: 403 }), store).delivery.drain();
    expect(store.m.size).toBe(0);
  });

  it("never lets a full store or broken saved data touch the page", async () => {
    const store = memory();
    store.setItem = () => { throw new Error("quota"); };
    const { delivery, calls } = harness(undefined, store);
    delivery.sendNow([chunk()]);
    expect(calls).toHaveLength(1);
    const broken = memory();
    broken.setItem("csa_rs_pending", "{not json");
    await harness(undefined, broken).delivery.drain();
  });

  it("does not grow past its storage limit", () => {
    const store = memory();
    const big = Array.from({ length: 12_000 }, (_, i) => ({ timestamp: i, r: Math.random().toString(36) + Math.random().toString(36) + Math.random().toString(36) }));
    const { delivery } = harness(dead, store);
    for (let q = 0; q < 12; q++) delivery.sendNow([chunk(`s=rs_a&q=${q}`, big)]);
    const kept = JSON.parse(store.m.get("csa_rs_pending")!) as unknown[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    expect(store.m.get("csa_rs_pending")!.length).toBeLessThan(1_600_000);
  });
});
