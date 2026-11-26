/*
  replay.js: session replay for SIGNED-IN users, and, where the product allows it (`replayVisitors`),
  for website VISITORS who accepted analytics, from the moment the page decides they started
  something worth watching (`csaReplay.startVisitor()`, e.g. the first file dropped in a free tool).
  The server records a visitor only when the request carries the consent cookie `csa_id`; consent
  withdrawn: `csaReplay.revoke()` stops at once and drops what was not sent yet.
  Signed-in users, in the product's app:
    <script defer src="https://t.example.com/replay.js" data-user-token="u1...." data-exclude="/billing,/settings"></script>
  or, in an SPA after sign-in:  window.csaReplay.start("u1....")  and csaReplay.stop() on sign-out.

  Privacy by default: every input masked, `.csa-private`, `.ph-no-capture` and `[data-private]`
  blocked, excluded paths not recorded, no console, no network bodies, no canvas.
  `data-mask-inputs="passwords"` (the founder's view, what our products use since 2026-10-31): the
  whole page and everything typed is recorded, documents included; only password fields are masked
  and only `[data-secret]` / `.csa-secret` blocks (an API key shown in clear) are blanked.
  `data-mask-inputs="sensitive"`: inputs in clear except passwords, emails, phone numbers, payment
  and one-time-code fields and anything whose name looks like a secret. `data-mask-text` masks page text under a selector (`*` = all).
  Chunks: every 30 s or ~256 KB (the first one carries the Meta event with its full snapshot), gzip in the browser, POST /r (replay-delivery.ts keeps them alive
  through a page change, retries a failed chunk up to 5 times and takes a fresh snapshot if one is
  lost for good). JS errors are recorded as `error` custom events (message sanitized, 20 per session
  at most) so the player and an AI reading the timeline see what broke. The server can answer
  {stop: true} (opt-out, daily cap): recording stops for the page.
*/
import { record } from "@rrweb/record";
import { chunkDelivery, REPLAY_BATCH_BYTES, type Answer } from "./replay-delivery";

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
  let buffer: string[] = [];
  let metaOnly = false;
  let size = 2, seq = 0, clicks = 0, errors = 0, recordedErrors = 0, lastClickAt = -Infinity, stopped = false;
  let renewed = false;
  /** The server's cap per session (src/replay.ts). Past it, every chunk is refused for nothing. */
  const MAX_SEQ = 720;
  const MAX_ERROR_EVENTS = 20;
  function newSession() {
    const a = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const id = "rs_" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => a[b % 62]).join("");
    try { sessionStorage.setItem("csa_rs", id); } catch { /* private mode */ }
    return id;
  }
  let session = sessionStorage.getItem("csa_rs") || "";
  if (!/^rs_[A-Za-z0-9]{20}$/.test(session)) session = newSession();
  try { seq = Number(sessionStorage.getItem(`csa_seq_${session}`)) || 0; } catch { /* */ }

  // Prefixes; a `*` stands for one path segment, e.g. /sites/*/settings/plan.
  const patterns = exclude.map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "(/|$)"));
  const excluded = () => patterns.some((re) => re.test(location.pathname));

  /** A session belongs to one person. Another account signing in on this tab inherited the id and
      had every chunk refused with 403, on and on (152 in two days): start over, once. */
  function onAnswer(answer: Answer, of: string) {
    if (of !== session) return;
    if (answer === "stop" || answer === "unauthorized") { delivery.discard(session); stop(true); return; }
    if (answer === "failed") {
      // A chunk was dropped after retries: take a fresh snapshot once so the rest of the session stays playable.
      if (stopFn && document.visibilityState === "visible") { try { record.takeFullSnapshot(); } catch { /* */ } }
      return;
    }
    if (answer !== "refused") return;
    delivery.discard(session);
    if (renewed) { stop(true); return; }
    renewed = true;
    end();
    buffer = []; metaOnly = false; size = 2; clicks = 0; errors = 0; recordedErrors = 0; seq = 0;
    session = newSession();
    begin();
  }
  const delivery = chunkDelivery({ endpoint, store: sessionStorage, send: (...args) => fetch(...args), token: () => token, onAnswer });

  function flush(final = false) {
    if (!buffer.length || !token || stopped) return;
    if (seq >= MAX_SEQ) { stop(true); return; }
    const json = `[${buffer.join(",")}]`;
    buffer = []; metaOnly = false; size = 2;
    const q = new URLSearchParams({ s: session, q: String(seq++), c: String(clicks), er: String(errors), pg: location.pathname });
    clicks = 0; errors = 0;
    try { sessionStorage.setItem(`csa_seq_${session}`, String(seq)); } catch { /* */ }
    const chunk = { session, query: q.toString(), json };
    if (final) delivery.sendNow([chunk]); else { void delivery.drain(); void delivery.send(chunk); }
  }
  function leaving() {
    if (buffer.length) flush(true); else delivery.sendNow([]);
  }

  function sanitizeError(raw: string) {
    return raw
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
      .replace(/https?:\/\/[^\s)]+/gi, (u) => { try { const p = new URL(u); return `${p.origin}${p.pathname}`; } catch { return "<url>"; } })
      .replace(/(["'`])[^"'`]{8,}?\1/g, "$1<redacted>$1")
      .replace(/\b\d{6,}\b/g, "<num>")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 160);
  }

  function recordError(msg: string, src = "", line = 0) {
    errors++;
    if (!stopFn || recordedErrors >= MAX_ERROR_EVENTS) return;
    recordedErrors++;
    let cleanSrc = "";
    if (src) {
      try { cleanSrc = new URL(src, location.href).pathname; } catch { cleanSrc = ""; }
    }
    try {
      record.addCustomEvent("error", { msg: sanitizeError(msg) || "Script error", ...(cleanSrc ? { src: cleanSrc.slice(0, 120) } : {}), ...(line ? { line } : {}) });
    } catch { /* recorder not ready */ }
  }

  function begin() {
    if (stopFn || stopped || !token || excluded()) return;
    stopFn = record({
      emit(e: any) {
        const json = JSON.stringify(e);
        const bytes = json.length;
        // Keep the tiny Meta event (type 4) together with its FullSnapshot (type 2) instead of
        // wasting a separate ~130 B HTTP POST / R2 object on every session start.
        if (buffer.length && !(metaOnly && e.type === 2) && size + 1 + bytes > REPLAY_BATCH_BYTES) flush();
        if (stopped) return;
        metaOnly = buffer.length === 0 && e.type === 4;
        size += bytes + (buffer.length ? 1 : 0);
        buffer.push(json);
        if (e.type === 3 && e.data?.source === 2 && (e.data?.type === 2 || e.data?.type === 9)) {
          const ts = typeof e.timestamp === "number" ? e.timestamp : Date.now();
          if (ts - lastClickAt >= 600) { clicks++; lastClickAt = ts; }
        }
        // A single full snapshot must stay intact for rrweb.
        if (size >= REPLAY_BATCH_BYTES) flush();
      },
      maskAllInputs: true,
      maskInputFn: passwordsOnly ? (text: string, el: HTMLElement | null) => (password(el) ? "*".repeat(text.length) : text)
        : sensitiveOnly ? (text: string, el: HTMLElement | null) => (sensitive(el) ? "*".repeat(text.length) : text) : undefined,
      maskTextSelector: maskText || undefined,
      blockSelector: passwordsOnly ? ".csa-secret, [data-secret]" : ".csa-private, .ph-no-capture, [data-private]",
      slimDOMOptions: "all",
      userTriggeredOnInput: true,
      sampling: { mousemove: 100, scroll: 150, input: "last" },
      recordCanvas: false,
      collectFonts: false,
      errorHandler: () => true,
    });
  }
  function end() { if (stopFn) { stopFn(); stopFn = undefined; } }
  function stop(forGood: boolean) { end(); stopped = forGood; buffer = []; metaOnly = false; size = 2; }

  setInterval(() => flush(), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leaving();
    else void delivery.drain();
  });
  addEventListener("pagehide", leaving);
  addEventListener("pageshow", (e) => { if (e.persisted) void delivery.drain(); });
  addEventListener("error", (e) => {
    recordError(String(e.message || e.error?.message || "Script error"), String(e.filename || ""), Number(e.lineno) || 0);
  });
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? r.message : typeof r === "string" ? r : "Unhandled rejection";
    recordError(`unhandledrejection: ${msg}`);
  });

  let path = location.pathname;
  function checkRoute() {
    if (location.pathname === path) return;
    path = location.pathname;
    if (excluded()) { flush(); end(); } else begin();
  }
  for (const m of ["pushState", "replaceState"] as const) {
    const orig = history[m];
    history[m] = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = orig.apply(this, args);
      checkRoute();
      return r;
    } as History[typeof m];
  }
  addEventListener("popstate", checkRoute);
  if ((w as any).navigation?.addEventListener) {
    try { (w as any).navigation.addEventListener("navigatesuccess", checkRoute); } catch { /* */ }
  }
  // Fallback for routers that cached history.pushState before this deferred script loaded.
  setInterval(() => { if (token && !stopped) checkRoute(); }, 3_000);

  w.csaReplay = {
    start(t: string) { token = t; begin(); void delivery.drain(); },
    /* A visitor: the consent cookie, sent along, is their identity. */
    startVisitor() { w.csaReplay.start("visitor"); },
    // Sign-out: flush the tail, then start a fresh session for the next person.
    stop() {
      leaving();
      delivery.discard(session);
      stop(false);
      token = null;
      session = newSession();
      seq = 0;
      recordedErrors = 0;
      lastClickAt = -Infinity;
      renewed = false;
    },
    // Consent withdrawn: stop immediately and drop pending chunks without flushing.
    revoke() {
      delivery.discard(session);
      stop(false);
      token = null;
      try { sessionStorage.removeItem("csa_rs"); sessionStorage.removeItem(`csa_seq_${session}`); } catch { /* */ }
      session = newSession();
      seq = 0;
      recordedErrors = 0;
      lastClickAt = -Infinity;
      renewed = false;
    },
  };
  const initial = script?.getAttribute("data-user-token");
  /* Not while the browser prerenders the page: nobody is looking at it yet, and it may never be opened. */
  if (initial) {
    if ((document as Document & { prerendering?: boolean }).prerendering) document.addEventListener("prerenderingchange", () => w.csaReplay.start(initial), { once: true });
    else w.csaReplay.start(initial);
  }
})();
