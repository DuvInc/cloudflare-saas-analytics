/*
  t.js, the Cloudflare SaaS Analytics tracker. Served by t.<product domain>, a few KB, no dependency.

    <script defer src="https://t.example.com/t.js"></script>
    <script defer src="https://t.example.com/t.js" data-user-token="u1...."></script>   (signed-in pages)

  Writes nothing on the device. The consent cookie `csa_id` is set by the server, HttpOnly, and
  only when the page's consent engine says analytics is granted (window.csaConsent or
  window.cookieConsent, event `cookie-consent`). With no consent engine on the page, it stays at
  level 0: anonymous, daily hash only.

  API (queued before load):  window.csa = window.csa || function () { (csa.q = csa.q || []).push(arguments) };
    csa("track", "pricing_plan_clicked", { plan: "pro" })
    csa("identify", "<user token from the product's server>")
    csa("consent")          re-read the consent engine (it already listens to `cookie-consent`)
*/
type Props = Record<string, string | number | boolean>;
type Consent = { granted(c: string): boolean } | undefined;

(function () {
  const w = window as unknown as Record<string, any>;
  const d = document;
  const script = d.currentScript as HTMLScriptElement | null;
  if (!script || w.__csa) return;
  w.__csa = true;
  const endpoint = new URL(script.src).origin + "/e";
  let token: string | null = script.getAttribute("data-user-token");

  const engine = (): Consent => w.csaConsent || w.cookieConsent;
  const consent = (): 1 | 0 | null => {
    const e = engine();
    if (!e || typeof e.granted !== "function") return null;
    try { return e.granted("analytics") ? 1 : 0; } catch { return null; }
  };
  let lastConsent: 1 | 0 | null = consent();

  function send(hits: Record<string, unknown>[], beacon = false) {
    const body = JSON.stringify({ c: consent(), k: token, e: hits });
    try {
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(endpoint, body); return; }
      fetch(endpoint, { method: "POST", body, keepalive: true, credentials: "include", mode: "cors" }).catch(() => {});
    } catch { /* never break the page */ }
  }

  const base = () => ({
    u: location.href, ts: Date.now(), lang: navigator.language,
    sw: screen.width, sh: screen.height, vw: innerWidth, vh: innerHeight,
    wd: navigator.webdriver ? 1 : 0,
  });

  /* ------------------------------------------------ engagement, scroll, vitals of the current page */
  let shownAt = d.visibilityState === "visible" ? Date.now() : 0;
  let engaged = 0, maxScroll = 0, lcp: number | null = null, cls = 0, inp: number | null = null;
  let pageUrl = location.href, referrer = d.referrer, left = false, viewed = false;
  const firstUrl = location.href;

  const scrollPct = () => {
    const h = d.documentElement.scrollHeight - innerHeight;
    return h <= 0 ? 100 : Math.min(100, Math.round((scrollY / h) * 100));
  };
  addEventListener("scroll", () => { maxScroll = Math.max(maxScroll, scrollPct()); }, { passive: true });
  try {
    new PerformanceObserver((l) => { const e = l.getEntries(); const last = e[e.length - 1]; if (last) lcp = Math.round(last.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (e.interactionId) inp = Math.max(inp ?? 0, e.duration); }).observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
  } catch { /* old browser */ }

  function pageview() {
    viewed = true;
    left = false;
    maxScroll = scrollPct();
    send([{ n: "$pageview", r: referrer, ...base(), u: pageUrl }]);
  }
  function pageleave(beacon: boolean) {
    /* A prerendered page thrown away unseen has no view to close. */
    if (left || !viewed) return;
    left = true;
    if (shownAt) { engaged += Date.now() - shownAt; shownAt = d.visibilityState === "visible" ? Date.now() : 0; }
    send([{ n: "$pageleave", ...base(), u: pageUrl, em: engaged, sp: maxScroll, lcp, inp, cls: Math.round(cls * 1000) / 1000 }], beacon);
    engaged = 0; lcp = null; inp = null; cls = 0;
  }

  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "hidden") { if (shownAt) { engaged += Date.now() - shownAt; shownAt = 0; } pageleave(true); }
    else { shownAt = Date.now(); if (left) { left = false; } }
  });
  addEventListener("pagehide", () => pageleave(true));

  /* ------------------------------------------------ single-page apps */
  function route() {
    if (location.href.split("#")[0] === pageUrl.split("#")[0]) return;
    pageleave(false);
    referrer = pageUrl;
    pageUrl = location.href;
    shownAt = d.visibilityState === "visible" ? Date.now() : 0;
    pageview();
  }
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History["pushState"]>) { const r = orig.apply(this, args); setTimeout(route, 0); return r; } as History[typeof m];
  }
  addEventListener("popstate", route);

  /* ------------------------------------------------ consent changes */
  d.addEventListener("cookie-consent", () => {
    const c = consent();
    if (c === lastConsent) return;
    lastConsent = c;
    /* `$consent` carries the landing (first referrer and URL of this page) so the new cookie is
       attributed to it at once; it is not a page view. A "no" clears the cookie. */
    send([{ n: "$consent", r: d.referrer, ...base(), u: firstUrl }]);
  });

  /* ------------------------------------------------ API */
  const api = (cmd: string, a?: unknown, b?: unknown) => {
    if (cmd === "track" && typeof a === "string") send([{ n: a, ...base(), p: (b as Props) ?? undefined }]);
    else if (cmd === "identify") token = typeof a === "string" ? a : null;
    else if (cmd === "consent") lastConsent = consent();
  };
  const queued: IArguments[] = (w.csa && w.csa.q) || [];
  w.csa = api;
  for (const args of queued) api(args[0], args[1], args[2]);

  /* A page prerendered by the browser (speculation rules: a docs link hovered) runs its scripts
     before anyone opens it, and may never be opened: it counts from the moment it is shown. */
  if ((d as Document & { prerendering?: boolean }).prerendering) {
    d.addEventListener("prerenderingchange", () => { shownAt = Date.now(); pageview(); }, { once: true });
  } else pageview();
})();
