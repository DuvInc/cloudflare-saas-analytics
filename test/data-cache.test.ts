import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedData, clearDataCache, loadData } from "../web/src/lib/data-cache";

beforeEach(() => clearDataCache());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const fetcher = () => vi.fn(async () => new Response(JSON.stringify({ value: 1 }), { status: 200 }));

describe("dashboard request cache", () => {
  it("does not overwrite an explicit refresh with an older response", async () => {
    const finish: ((value: Response) => void)[] = [];
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => finish.push(resolve)));
    const older = loadData("/api/x");
    const fresh = loadData("/api/x", true);
    finish[1]!(new Response('{"value":2}')); await fresh;
    finish[0]!(new Response('{"value":1}')); await older;
    expect(cachedData("/api/x")?.data).toEqual({ value: 2 });
  });
  it("coalesces requests and reuses a fresh answer", async () => {
    const fetch = fetcher(); vi.stubGlobal("fetch", fetch);
    expect(await Promise.all([loadData("/api/x"), loadData("/api/x")])).toEqual([{ value: 1 }, { value: 1 }]);
    await loadData("/api/x");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("revalidates after 30 seconds and bypasses server caches on reload", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fetch = fetcher(); vi.stubGlobal("fetch", fetch);
    await loadData("/api/x");
    vi.setSystemTime(30_001); await loadData("/api/x");
    await loadData("/api/x", true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![1].headers["x-csa-refresh"]).toBe("1");
  });
  it("does not retain failed responses", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(fetcher()); vi.stubGlobal("fetch", fetch);
    await expect(loadData("/api/x")).rejects.toThrow("offline");
    expect(cachedData("/api/x")).toBeUndefined();
    await loadData("/api/x"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cannot repopulate a cache cleared during sign-out", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    const waiting = loadData("/api/private");
    clearDataCache(); finish(new Response("{}")); await waiting;
    expect(cachedData("/api/private")).toBeUndefined();
  });
});
