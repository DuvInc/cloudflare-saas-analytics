/* The tracker on a page the browser prerenders (speculation rules on our docs): it must not count
   a view until the page is shown, and a prerendered page thrown away unseen must send nothing. */
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = (await build({ entryPoints: ["client/tracker.ts"], bundle: true, format: "iife", write: false, target: "es2019" })).outputFiles[0].text;

function page({ prerendering }: { prerendering: boolean }) {
  const listeners: Record<string, Array<() => void>> = {};
  const on = (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); };
  const sent: string[] = [];
  const document = {
    prerendering,
    visibilityState: prerendering ? "hidden" : "visible",
    referrer: "",
    currentScript: { src: "https://t.example.com/t.js", getAttribute: () => null },
    documentElement: { scrollHeight: 1000 },
    addEventListener: on,
  };
  const window: Record<string, unknown> = {
    document,
    location: { href: "https://example.com/docs/a" },
    navigator: { language: "en", webdriver: false, sendBeacon: (_: string, body: string) => { sent.push(body); return true; } },
    screen: { width: 1280, height: 800 },
    innerWidth: 1280, innerHeight: 800, scrollY: 0,
    history: { pushState() {}, replaceState() {} },
    addEventListener: on,
    fetch: (_: string, init: { body: string }) => { sent.push(init.body); return Promise.resolve(); },
    setTimeout, Date, JSON, URL, Math, Promise,
  };
  window.window = window;
  runInNewContext(source, window);
  const fire = (type: string) => { for (const fn of listeners[type] ?? []) fn(); };
  const names = () => sent.flatMap((body) => (JSON.parse(body).e as Array<{ n: string }>).map((hit) => hit.n));
  return { document, fire, names };
}

describe("tracker on a prerendered page", () => {
  it("counts a normal page at once", () => {
    expect(page({ prerendering: false }).names()).toEqual(["$pageview"]);
  });

  it("waits for the page to be shown before counting it", () => {
    const p = page({ prerendering: true });
    expect(p.names()).toEqual([]);
    p.document.prerendering = false;
    p.document.visibilityState = "visible";
    p.fire("prerenderingchange");
    expect(p.names()).toEqual(["$pageview"]);
  });

  it("sends nothing for a prerendered page thrown away unseen", () => {
    const p = page({ prerendering: true });
    p.fire("visibilitychange");
    p.fire("pagehide");
    expect(p.names()).toEqual([]);
  });
});
