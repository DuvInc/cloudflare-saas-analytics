/*
  POST https://t.<product domain>/r?s=<session>&q=<seq>&k=<user token>&c=<clicks>&er=<errors>&pg=<path>
  Body: one gzip chunk of rrweb events (JSON array), compressed in the browser.

  Signed-in users only: no valid user token, no write. Bounded: 512 KB per chunk, 720 chunks per
  session (6 h at one every 30 s), `replayDailyCap` new sessions per product and UTC day, and the
  same rate limits as the collector. Chunks live 30 days (R2 lifecycle rule on `replays/`).
*/
import { corsHeaders, killed } from "./collect";
import type { Env } from "./env";
import { gunzipBounded, rateLimitIpKey, readBoundedBytes } from "./http-security";
import { utcDay, verifyUser } from "./identity";
import { pool } from "./pool";
import type { Product } from "./products";

const MAX_CHUNK = 512 * 1024;
const MAX_CHUNK_UNCOMPRESSED = 4 * 1024 * 1024;
const MAX_SESSION_UNCOMPRESSED = 32 * 1024 * 1024;
const MAX_SEQ = 720;

export async function handleReplay(req: Request, env: Env, p: Product): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), p);
  const reply = (status: number, body?: string) => new Response(body ?? null, { status, headers: { ...cors, "cache-control": "no-store", ...(body ? { "content-type": "application/json" } : {}) } });
  if (!cors["access-control-allow-origin"]) return reply(403);
  if (!p.replay) return reply(204);
  const url = new URL(req.url);
  const session = url.searchParams.get("s") ?? "";
  const seq = Number(url.searchParams.get("q"));
  if (!/^rs_[A-Za-z0-9]{16,32}$/.test(session) || !Number.isInteger(seq) || seq < 0 || seq >= MAX_SEQ) return reply(400);
  const ipKey = rateLimitIpKey(req.headers.get("cf-connecting-ip"));
  const [a, b] = await Promise.all([env.PER_IP.limit({ key: `r:${ipKey}` }), env.PER_PRODUCT.limit({ key: `r:${p.id}` })]);
  if (!a.success || !b.success) return reply(429);
  if (await killed(env, p.id)) return reply(204);

  const rawBody = await readBoundedBytes(req, MAX_CHUNK + 1024);
  if (!rawBody || !rawBody.byteLength) return reply(413);

  /* Extract user token from binary body prefix `<u1 token>\n<gzip>` (zero preflight, zero URL leak),
     falling back to `x-csa-user` header or legacy `?k=` during client cache rollout. */
  let rawToken: string | null = req.headers.get("x-csa-user") ?? url.searchParams.get("k");
  let body = rawBody;
  if (!(rawBody[0] === 0x1f && rawBody[1] === 0x8b)) {
    const nl = rawBody.subarray(0, 620).indexOf(0x0a);
    if (nl <= 0) return reply(400);
    rawToken = new TextDecoder().decode(rawBody.subarray(0, nl));
    body = rawBody.slice(nl + 1);
  }
  if (!body.byteLength || body.byteLength > MAX_CHUNK) return reply(413);

  const user = await verifyUser(env, rawToken, p.id);
  if (!user) return reply(401);
  const optOut = await env.DB.prepare("SELECT replay_opt_out FROM people WHERE product = ? AND user_id = ?").bind(p.id, user.u).first<{ replay_opt_out: number }>();
  if (optOut?.replay_opt_out) return reply(200, JSON.stringify({ stop: true }));

  /* Validate gzip & decompressed byte ceiling at the door so a gzip bomb never enters R2. */
  const unzipped = await gunzipBounded(body, MAX_CHUNK_UNCOMPRESSED);
  if (!unzipped) return reply(413);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(unzipped));
    if (!Array.isArray(parsed)) return reply(400);
  } catch {
    return reply(400);
  }

  const now = Date.now();
  const clicks = Math.max(0, Math.min(Number(url.searchParams.get("c")) || 0, 10_000));
  const errors = Math.max(0, Math.min(Number(url.searchParams.get("er")) || 0, 10_000));
  const page = (url.searchParams.get("pg") ?? "").slice(0, 200);

  let row = await env.DB.prepare("SELECT product, user_id, day, pages FROM replay_sessions WHERE id = ?").bind(session).first<{ product: string; user_id: string; day: string; pages: string }>();
  if (row && (row.product !== p.id || row.user_id !== user.u)) return reply(403);
  if (!row) {
    const today = utcDay(now);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM replay_sessions WHERE product = ? AND day = ?").bind(p.id, today).first<{ n: number }>();
    if ((count?.n ?? 0) >= p.replayDailyCap) return reply(200, JSON.stringify({ stop: true, reason: "daily_cap" }));
    await env.DB.prepare("INSERT OR IGNORE INTO replay_sessions (id, product, user_id, host, started_at, last_at, day, pages) VALUES (?, ?, ?, ?, ?, ?, ?, '[]')")
      .bind(session, p.id, user.u, new URL(req.headers.get("origin") ?? "https://x").hostname, now, now, today).run();
    const reread = await env.DB.prepare("SELECT product, user_id, day, pages FROM replay_sessions WHERE id = ?").bind(session).first<{ product: string; user_id: string; day: string; pages: string }>();
    if (!reread || reread.product !== p.id || reread.user_id !== user.u) return reply(403);
    row = reread;
  }

  /* Deduplicate (session_id, seq): retries or duplicate beacons neither overwrite R2 nor inflate metrics. */
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO replay_chunks (session_id, seq, bytes, day) VALUES (?, ?, ?, ?)")
    .bind(session, seq, body.byteLength, row.day).run();
  if (claim.meta.changes === 0) return reply(204);

  const key = `replays/${p.id}/${row.day}/${session}/${String(seq).padStart(4, "0")}.json.gz`;
  await env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
  const pages = JSON.parse(row.pages || "[]") as string[];
  if (page && !pages.includes(page) && pages.length < 50) pages.push(page);
  await env.DB.prepare("UPDATE replay_sessions SET last_at = MAX(last_at, ?), chunks = chunks + 1, bytes = bytes + ?, clicks = clicks + ?, errors = errors + ?, pages = ? WHERE id = ? AND product = ?")
    .bind(now, body.byteLength, clicks, errors, JSON.stringify(pages), session, p.id).run();
  return reply(204);
}

/** All chunks of a session, decompressed with a strict memory cap and concatenated into one rrweb event array. */
export async function replayEvents(env: Env, product: string, day: string, session: string): Promise<unknown[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix: `replays/${product}/${day}/${session}/`, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  keys.sort();
  let remaining = MAX_SESSION_UNCOMPRESSED;
  const decodedChunks = await pool(keys, 6, async (key) => {
    if (remaining <= 0) return null;
    const obj = await env.BUCKET.get(key);
    if (!obj) return null;
    const raw = new Uint8Array(await obj.arrayBuffer());
    const unzipped = await gunzipBounded(raw, Math.min(MAX_CHUNK_UNCOMPRESSED, Math.max(remaining, 1)));
    if (!unzipped) return null;
    remaining -= unzipped.byteLength;
    if (remaining < 0) return null;
    try {
      const arr = JSON.parse(new TextDecoder().decode(unzipped));
      return Array.isArray(arr) ? (arr as unknown[]) : null;
    } catch {
      return null;
    }
  });
  const out: unknown[] = [];
  for (const chunk of decodedChunks) if (chunk) out.push(...chunk);
  return out;
}
