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

export type Chunk = { session: string; query: string; events: unknown[] };
export type Answer = "ok" | "stop" | "refused" | "unauthorized" | "failed";

type KeptChunk = { s: string; q: string; b: string };
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const KEEPALIVE_LIMIT = 60_000;
const KEPT = "csa_rs_pending";
/** sessionStorage holds about 5 MB per origin and the product needs it too. */
const KEPT_LIMIT = 1_500_000;

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
  let draining = false;

  const kept = (): KeptChunk[] => {
    try { return JSON.parse(deps.store.getItem(KEPT) ?? "[]") as KeptChunk[]; } catch { return []; }
  };
  const save = (list: KeptChunk[]) => {
    try { if (list.length) deps.store.setItem(KEPT, JSON.stringify(list)); else deps.store.removeItem(KEPT); } catch { /* full or private mode: the chunk can only be lost */ }
  };
  const keep = (chunk: KeptChunk) => {
    const list = kept().filter((k) => !(k.s === chunk.s && k.q === chunk.q));
    if (list.reduce((total, k) => total + k.b.length, 0) + chunk.b.length > KEPT_LIMIT) return;
    save([...list, chunk]);
  };
  const forget = (session: string, query: string) => {
    const list = kept();
    const left = list.filter((k) => !(k.s === session && k.q === query));
    if (left.length !== list.length) save(left);
  };

  const body = (gz: Uint8Array) => {
    const prefix = new TextEncoder().encode(`${deps.token()}\n`);
    const payload = new Uint8Array(prefix.byteLength + gz.byteLength);
    payload.set(prefix, 0);
    payload.set(gz, prefix.byteLength);
    return payload;
  };
  const post = (query: string, payload: Uint8Array, keepalive: boolean) =>
    deps.send(`${deps.endpoint}?${query}`, { method: "POST", body: payload, keepalive, credentials: "omit", mode: "cors" });

  const answerOf = async (res: Response): Promise<Answer> => {
    if (res.status === 401) return "unauthorized";
    if (res.status === 403) return "refused";
    if (res.status === 200) { const b = await res.json().catch(() => ({})) as { stop?: boolean }; return b.stop ? "stop" : "ok"; }
    return res.status === 204 ? "ok" : "failed";
  };
  /** Rate limits and server errors may pass; a chunk the server rejects never will. */
  const settled = (res: Response) => res.status < 500 && res.status !== 429;

  return {
    /** The ordinary path, with the page staying: compress off the main thread. */
    async send(chunk: Chunk) {
      inFlight.add(chunk);
      try {
        const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(chunk.events)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        if (!inFlight.has(chunk)) return; // the page started leaving: sendNow took it over
        const res = await post(chunk.query, body(gz), false);
        inFlight.delete(chunk);
        forget(chunk.session, chunk.query);
        deps.onAnswer(await answerOf(res), chunk.session);
      } catch { /* a network failure: the replay has a gap, the page is untouched */ }
      inFlight.delete(chunk);
    },

    /** The page may be going away: nothing here may wait, not even one tick. */
    sendNow(chunks: Chunk[]) {
      let allowance = KEEPALIVE_LIMIT;
      for (const chunk of [...inFlight, ...chunks]) {
        inFlight.delete(chunk);
        const gz = gzipSync(strToU8(JSON.stringify(chunk.events)));
        keep({ s: chunk.session, q: chunk.query, b: toBase64(gz) });
        const payload = body(gz);
        const keepalive = payload.byteLength <= allowance;
        if (keepalive) allowance -= payload.byteLength;
        post(chunk.query, payload, keepalive)
          .then(async (res) => { forget(chunk.session, chunk.query); deps.onAnswer(await answerOf(res), chunk.session); })
          .catch(() => { /* still kept: the next page in this tab sends it */ });
      }
    },

    /** What an earlier page in this tab did not see answered. */
    async drain() {
      if (draining || !deps.token()) return;
      draining = true;
      try {
        for (const chunk of kept()) {
          try {
            const res = await post(chunk.q, body(fromBase64(chunk.b)), false);
            if (settled(res)) forget(chunk.s, chunk.q);
          } catch { return; /* offline: the next page tries again */ }
        }
      } finally { draining = false; }
    },
  };
}
