/*
  Getting replay chunks out of a page that may be going away.

  Compressing is asynchronous, and a page that navigates (to Stripe, on a reload) dies during that
  await: the chunk never left, and its sequence number was already spent. 19 of 122 sessions of one product
  had holes in the week to 2026-11-07, right around the checkout redirect, some missing the first
  chunk that holds the page itself. So on the way out a chunk is compressed synchronously, sent with
  `keepalive` if it fits the browser's 64 KB allowance, and kept in sessionStorage until the server
  has answered. sessionStorage survives Stripe and back in the same tab, so the next page sends what
  is left. Sending twice is harmless: the server deduplicates on (session, seq).
*/
import { gzipSync, strToU8 } from "fflate";

export type Chunk = { session: string; query: string; json: string };
export type Answer = "ok" | "stop" | "refused" | "unauthorized" | "failed";

type KeptChunk = { s: string; q: string; b: string; n?: number };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const KEEPALIVE_LIMIT = 60_000;
// Leave room below the server's 512 KiB gzip limit, even for poorly compressible events.
export const REPLAY_BATCH_BYTES = 256 * 1024;
const KEPT = "csa_rs_pending";
/** sessionStorage holds about 5 MB per origin and the product needs it too. */
const KEPT_LIMIT = 1_500_000;
const MAX_TRIES = 5;

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function chunkDelivery(deps: {
  endpoint: string;
  store: Store;
  send: typeof fetch;
  token: () => string | null;
  /** The answer to a chunk of the session being recorded. */
  onAnswer: (answer: Answer, session: string) => void;
}) {
  const inFlight = new Set<Chunk>();
  const posting = new Set<string>();
  const discarded = new Set<string>();
  let draining = false;
  const keyOf = (s: string, q: string) => `${s}\0${q}`;

  const kept = (): KeptChunk[] => {
    try { return JSON.parse(deps.store.getItem(KEPT) ?? "[]") as KeptChunk[]; } catch { return []; }
  };
  const save = (list: KeptChunk[]) => {
    try { if (list.length) deps.store.setItem(KEPT, JSON.stringify(list)); else deps.store.removeItem(KEPT); } catch { /* full or private mode: the chunk can only be lost */ }
  };
  const keep = (chunk: KeptChunk) => {
    if (discarded.has(chunk.s)) return;
    if ((chunk.n ?? 0) >= MAX_TRIES) { forget(chunk.s, chunk.q); return; }
    const list = kept().filter((k) => !(k.s === chunk.s && k.q === chunk.q));
    if (list.reduce((total, k) => total + k.b.length, 0) + chunk.b.length > KEPT_LIMIT) return;
    save([...list, chunk]);
  };
  const forget = (session: string, query: string) => {
    const list = kept();
    const left = list.filter((k) => !(k.s === session && k.q === query));
    if (left.length !== list.length) save(left);
  };

  const body = (tok: string, gz: Uint8Array) => {
    const prefix = new TextEncoder().encode(`${tok}\n`);
    const payload = new Uint8Array(prefix.byteLength + gz.byteLength);
    payload.set(prefix, 0);
    payload.set(gz, prefix.byteLength);
    return payload;
  };
  const post = (tok: string, query: string, payload: Uint8Array, keepalive: boolean) =>
    deps.send(`${deps.endpoint}?${query}`, { method: "POST", body: payload, keepalive, credentials: tok === "visitor" ? "include" : "omit", mode: "cors" });

  const answerOf = async (res: Response): Promise<Answer> => {
    if (res.status === 401) return "unauthorized";
    if (res.status === 403) return "refused";
    if (res.status === 200) { const b = await res.json().catch(() => ({})) as { stop?: boolean }; return b.stop ? "stop" : "ok"; }
    return res.status === 204 ? "ok" : "failed";
  };
  /** Rate limits and server errors may pass; a chunk the server rejects never will. */
  const settled = (res: Response) => res.status < 500 && res.status !== 429;

  return {
    discard(session: string) {
      discarded.add(session);
      for (const chunk of inFlight) if (chunk.session === session) inFlight.delete(chunk);
      save(kept().filter((chunk) => chunk.s !== session));
    },

    /** The ordinary path, with the page staying: compress off the main thread. */
    async send(chunk: Chunk) {
      discarded.delete(chunk.session);
      inFlight.add(chunk);
      const k = keyOf(chunk.session, chunk.query);
      let gz: Uint8Array | null = null;
      try {
        gz = new Uint8Array(await new Response(new Blob([chunk.json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        const tok = deps.token();
        if (!inFlight.has(chunk) || discarded.has(chunk.session) || !tok) { inFlight.delete(chunk); return; }
        posting.add(k);
        const res = await post(tok, chunk.query, body(tok, gz), false);
        inFlight.delete(chunk);
        posting.delete(k);
        if (discarded.has(chunk.session)) return;
        if (settled(res)) forget(chunk.session, chunk.query);
        else keep({ s: chunk.session, q: chunk.query, b: toBase64(gz), n: 1 });
        deps.onAnswer(await answerOf(res), chunk.session);
      } catch {
        posting.delete(k);
        /* A transient network drop: keep the compressed chunk so the next visible/drain resends it. */
        if (inFlight.delete(chunk) && gz && !discarded.has(chunk.session)) {
          keep({ s: chunk.session, q: chunk.query, b: toBase64(gz), n: 1 });
        }
      }
    },

    /** The page may be going away: nothing here may wait, not even one tick. */
    sendNow(chunks: Chunk[]) {
      const tok = deps.token();
      if (!tok) return;
      let allowance = KEEPALIVE_LIMIT;
      for (const chunk of [...inFlight, ...chunks]) {
        inFlight.delete(chunk);
        if (discarded.has(chunk.session)) continue;
        const gz = gzipSync(strToU8(chunk.json));
        keep({ s: chunk.session, q: chunk.query, b: toBase64(gz), n: 1 });
        const payload = body(tok, gz);
        const keepalive = payload.byteLength <= allowance;
        if (keepalive) allowance -= payload.byteLength;
        const k = keyOf(chunk.session, chunk.query);
        posting.add(k);
        post(tok, chunk.query, payload, keepalive)
          .then(async (res) => {
            posting.delete(k);
            if (discarded.has(chunk.session)) return;
            if (settled(res)) forget(chunk.session, chunk.query);
            deps.onAnswer(await answerOf(res), chunk.session);
          })
          .catch(() => { posting.delete(k); /* still kept: the next page in this tab sends it */ });
      }
    },

    /** What an earlier page in this tab did not see answered. */
    async drain() {
      if (draining || !deps.token()) return;
      draining = true;
      try {
        for (const chunk of kept()) {
          const tok = deps.token();
          if (!tok) return;
          if (discarded.has(chunk.s)) { forget(chunk.s, chunk.q); continue; }
          const k = keyOf(chunk.s, chunk.q);
          if (posting.has(k)) continue;
          const tries = (chunk.n ?? 0) + 1;
          if (tries > MAX_TRIES) { forget(chunk.s, chunk.q); deps.onAnswer("failed", chunk.s); continue; }
          posting.add(k);
          try {
            const res = await post(tok, chunk.q, body(tok, fromBase64(chunk.b)), false);
            posting.delete(k);
            if (discarded.has(chunk.s)) { forget(chunk.s, chunk.q); continue; }
            if (settled(res)) forget(chunk.s, chunk.q);
            else keep({ ...chunk, n: tries });
            deps.onAnswer(await answerOf(res), chunk.s);
          } catch {
            posting.delete(k);
            keep({ ...chunk, n: tries });
            return; /* offline: the next page tries again */
          }
        }
      } finally { draining = false; }
    },
  };
}
