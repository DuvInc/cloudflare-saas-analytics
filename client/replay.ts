/*
  replay.js: session replay for SIGNED-IN users only. Load it in the product's app, never on a
  marketing page:
    <script defer src="https://t.example.com/replay.js" data-user-token="u1...." data-exclude="/billing,/settings"></script>
  or, in an SPA after sign-in:  window.csaReplay.start("u1....")  and csaReplay.stop() on sign-out.

  Privacy by default: every input masked, `.csa-private`, `.ph-no-capture` and `[data-private]`
  blocked, excluded paths not recorded, no console, no network bodies, no canvas.
  `data-mask-inputs="passwords"` (the founder's view, what our products use since 2026-10-31): the
  whole page and everything typed is recorded, documents included; only password fields are masked
  and only `[data-secret]` / `.csa-secret` blocks (an API key shown in clear) are blanked.
  `data-mask-inputs="sensitive"`: inputs in clear except passwords, emails, phone numbers, payment
  and one-time-code fields and anything whose name looks like a secret. `data-mask-text` masks page text under a selector (`*` = all).
  Chunks: every 30 s or ~200 KB, gzip in the browser, POST /r. The server can answer
  {stop: true} (opt-out, daily cap): recording stops for the page.
*/
import { record } from "@rrweb/record";

(function () {
  const w = window as unknown as Record<string, any>;
  const script = document.currentScript as HTMLScriptElement | null;
  if (w.csaReplay) return;
  const endpoint = script ? new URL(script.src).origin + "/r" : "";
  const exclude = (script?.getAttribute("data-exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maskText = script?.getAttribute("data-mask-text") ?? "";
  const mode = script?.getAttribute("data-mask-inputs") ?? "";
  const sensitiveOnly = mode === "sensitive";
  const passwordsOnly = mode === "passwords";
  const password = (el: HTMLElement | null) => {
    if (!el) return true;
    const i = el as HTMLInputElement;
    return (i.type ?? "").toLowerCase() === "password" || /password/.test((i.getAttribute?.("autocomplete") ?? "").toLowerCase()) || !!el.closest?.("[data-secret], .csa-secret");
  };
  const SECRET = /pass|secret|token|api.?key|card|cvc|cvv|iban|ssn|otp/i;
  const sensitive = (el: HTMLElement | null) => {
    if (!el) return true;
    const i = el as HTMLInputElement;
    const type = (i.type ?? "").toLowerCase();
    const auto = (i.getAttribute?.("autocomplete") ?? "").toLowerCase();
    return ["password", "email", "tel", "hidden"].includes(type) || /^cc-|one-time-code|email|tel|password/.test(auto)
      || SECRET.test(`${i.name ?? ""} ${i.id ?? ""} ${i.getAttribute?.("placeholder") ?? ""}`) || !!el.closest?.("[data-private], .csa-private");
  };

  let token: string | null = null;
  let stopFn: (() => void) | undefined;
  let buffer: unknown[] = [];
  let size = 0, seq = 0, clicks = 0, errors = 0, stopped = false;
  let session = sessionStorage.getItem("csa_rs") || "";
  if (!/^rs_[A-Za-z0-9]{20}$/.test(session)) {
    const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    session = "rs_" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => a[b % 62]).join("");
    try { sessionStorage.setItem("csa_rs", session); } catch { /* private mode */ }
  }
  try { seq = Number(sessionStorage.getItem(`csa_seq_${session}`)) || 0; } catch { /* */ }

  // Prefixes; a `*` stands for one path segment, e.g. /sites/*/settings/plan.
  const patterns = exclude.map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "(/|$)"));
  const excluded = () => patterns.some((re) => re.test(location.pathname));

  async function flush(final = false) {
    if (!buffer.length || !token || stopped) return;
    const events = buffer; buffer = []; size = 0;
    const q = new URLSearchParams({ s: session, q: String(seq++), c: String(clicks), er: String(errors), pg: location.pathname });
    const prefix = new TextEncoder().encode(`${token}\n`);
    clicks = 0; errors = 0;
    try { sessionStorage.setItem(`csa_seq_${session}`, String(seq)); } catch { /* */ }
    try {
      const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(events)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      const payload = new Uint8Array(prefix.byteLength + gz.byteLength);
      payload.set(prefix, 0);
      payload.set(gz, prefix.byteLength);
      const res = await fetch(`${endpoint}?${q}`, { method: "POST", body: payload, keepalive: final && payload.byteLength < 60_000, credentials: "omit", mode: "cors" });
      if (res.status === 200) { const b = await res.json().catch(() => ({})); if (b.stop) stop(true); }
      if (res.status === 401) stop(true);
    } catch { /* lost chunk: the replay has a gap, the page is untouched */ }
  }

  function begin() {
    if (stopFn || stopped || !token || excluded()) return;
    stopFn = record({
      emit(e: any) {
        buffer.push(e);
        size += 200;
        if (e.type === 2) size += 100_000;
        if (e.type === 3 && e.data?.source === 2 && e.data?.type === 2) clicks++;
        if (size > 200_000) flush();
      },
      maskAllInputs: true,
      maskInputFn: passwordsOnly ? (text: string, el: HTMLElement | null) => (password(el) ? "*".repeat(text.length) : text)
        : sensitiveOnly ? (text: string, el: HTMLElement | null) => (sensitive(el) ? "*".repeat(text.length) : text) : undefined,
      maskTextSelector: maskText || undefined,
      blockSelector: passwordsOnly ? ".csa-secret, [data-secret]" : ".csa-private, .ph-no-capture, [data-private]",
      sampling: { mousemove: 100, scroll: 150, input: "last" },
      checkoutEveryNms: 10 * 60_000,
      recordCanvas: false,
      collectFonts: false,
    });
  }
  function end() { if (stopFn) { stopFn(); stopFn = undefined; } }
  function stop(forGood: boolean) { end(); if (forGood) stopped = true; buffer = []; }

  setInterval(() => flush(), 30_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
  addEventListener("pagehide", () => flush(true));
  addEventListener("error", () => { errors++; });
  addEventListener("unhandledrejection", () => { errors++; });

  let path = location.pathname;
  setInterval(() => {
    if (location.pathname === path) return;
    path = location.pathname;
    if (excluded()) { flush(); end(); } else begin();
  }, 500);

  w.csaReplay = {
    start(t: string) { token = t; begin(); },
    stop() { flush(true); stop(false); token = null; },
  };
  const initial = script?.getAttribute("data-user-token");
  if (initial) w.csaReplay.start(initial);
})();
