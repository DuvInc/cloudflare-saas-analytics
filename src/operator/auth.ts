/*
  THE OPERATOR IS PROVED BY A PASSKEY. No Cloudflare Access, no password.

  No password and no third party: each of the operator's devices holds a passkey (fingerprint, face or
  screen lock), and signing in with it opens a session for that device only: an HttpOnly cookie
  whose hash is in D1, 30 days, renewed while in use, revocable from any other signed-in device.

  How the first passkey exists: a one-time enrollment link (`npm run csa -- enroll`, or "Add a
  device" from a device already signed in), valid 15 to 30 minutes, stored as a hash, consumed
  by the registration it opens. Without such a link nobody can register a passkey, so knowing the
  address of the dashboard gives nothing.

  Local development keeps a bypass, only when ENVIRONMENT is "development" (`.dev.vars`, which a
  deploy never reads) AND the host is exactly `localhost`.
*/
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isDevelopment, type Env } from "../env";
import { b64url, fromB64url, hmacB64url, newId, newSecret, sha256Hex, timingSafeEqual, utf8 } from "../crypto";
import { rateLimitIpKey, readBoundedText } from "../http-security";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type Operator = { actor: string; sessionId: string | null; exp: number; renewed?: string };

const SESSION_MS = 30 * 24 * 3600_000;
const CHALLENGE_MS = 5 * 60_000;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers } });
const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json({ error: { code, message } }, status, headers);

const cookieName = (url: URL) => (url.protocol === "https:" ? "__Host-csa_op" : "csa_op");
export function sessionCookie(url: URL, token: string, maxAgeSeconds: number) {
  return `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${url.protocol === "https:" ? "; Secure" : ""}`;
}
function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function deviceLabel(request: Request): string {
  const ua = request.headers.get("user-agent") ?? "";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Mac OS X/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os}, ${browser}`;
}

export async function verifyOperator(request: Request, env: Env): Promise<Operator | null> {
  const url = new URL(request.url);
  if (isDevelopment(env) && env.DEV_OPERATOR_EMAIL && url.hostname === "localhost") {
    return { actor: `dev:${env.DEV_OPERATOR_EMAIL}`, sessionId: null, exp: Date.now() + 12 * 3600_000 };
  }
  const token = readCookie(request, cookieName(url));
  if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT id, expires_at, revoked_at, last_seen_at FROM operator_sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token)).first<{ id: string; expires_at: number; revoked_at: string | null; last_seen_at: string }>();
  if (!row || row.revoked_at || row.expires_at <= Date.now()) return null;
  /* Sliding: a session in use is renewed at most once an hour, cookie included. */
  if (Date.now() - Date.parse(row.last_seen_at) > 3600_000) {
    const exp = Date.now() + SESSION_MS;
    await env.DB.prepare("UPDATE operator_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(new Date().toISOString(), exp, row.id).run();
    return { actor: `session:${row.id}`, sessionId: row.id, exp, renewed: sessionCookie(url, token, SESSION_MS / 1000) };
  }
  return { actor: `session:${row.id}`, sessionId: row.id, exp: row.expires_at };
}

/** The anti-CSRF token, bound to the session. */
export async function csrfToken(env: Env, operator: Operator): Promise<string | null> {
  if (!env.OPERATOR_SECRET || env.OPERATOR_SECRET.length < 32) return null;
  return hmacB64url(env.OPERATOR_SECRET, `csrf:${operator.sessionId ?? operator.actor}`);
}
export async function csrfOk(request: Request, env: Env, operator: Operator): Promise<boolean> {
  const expected = await csrfToken(env, operator);
  const got = request.headers.get("x-csa-csrf") ?? "";
  if (!expected || !timingSafeEqual(got, expected)) return false;
  return request.headers.get("origin") === new URL(request.url).origin;
}

/* ---------------------------------------------------------------- enrollment codes */

export async function createEnrollment(env: Env, createdBy: string, minutes: number): Promise<string> {
  const code = newSecret();
  await env.DB.prepare("INSERT INTO operator_enrollments (code_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(code), new Date().toISOString(), Date.now() + minutes * 60_000, createdBy).run();
  return code;
}

async function openEnrollment(env: Env, code: unknown): Promise<string | null> {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(code)) return null;
  const hash = await sha256Hex(code);
  const row = await env.DB.prepare("SELECT code_hash FROM operator_enrollments WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(hash, Date.now()).first<{ code_hash: string }>();
  return row?.code_hash ?? null;
}

/* ---------------------------------------------------------------- challenges, single use */

async function storeChallenge(env: Env, challenge: string, kind: "register" | "login", codeHash: string | null): Promise<string> {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM operator_challenges WHERE expires_at < ? OR used = 1").bind(now).run();
  /* Bound table size without allowing unauthenticated traffic to lock out the operator:
     PER_IP caps individual callers, and FIFO eviction trims oldest unused login challenges above 200. */
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_challenges").first<{ n: number }>();
  const excess = (open?.n ?? 0) - 199;
  if (excess > 0) {
    await env.DB.prepare("DELETE FROM operator_challenges WHERE id IN (SELECT id FROM operator_challenges WHERE kind = 'login' ORDER BY expires_at ASC LIMIT ?)").bind(excess).run();
  }
  const id = newId("ch");
  await env.DB.prepare("INSERT INTO operator_challenges (id, challenge, kind, code_hash, expires_at) VALUES (?, ?, ?, ?, ?)").bind(id, challenge, kind, codeHash, now + CHALLENGE_MS).run();
  return id;
}

async function takeChallenge(env: Env, id: unknown, kind: "register" | "login"): Promise<{ challenge: string; code_hash: string | null } | null> {
  if (typeof id !== "string") return null;
  const row = await env.DB.prepare("SELECT challenge, code_hash FROM operator_challenges WHERE id = ? AND kind = ? AND used = 0 AND expires_at > ?").bind(id, kind, Date.now()).first<{ challenge: string; code_hash: string | null }>();
  if (!row) return null;
  const res = await env.DB.prepare("UPDATE operator_challenges SET used = 1 WHERE id = ? AND used = 0").bind(id).run();
  return res.meta.changes === 1 ? row : null;
}

async function openSession(env: Env, request: Request, passkeyId: string): Promise<string> {
  const token = newSecret();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO operator_sessions (id, token_hash, passkey_id, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("os"), await sha256Hex(token), passkeyId, deviceLabel(request), now, now, Date.now() + SESSION_MS).run();
  return sessionCookie(new URL(request.url), token, SESSION_MS / 1000);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request, 32 * 1024);
  if (text === null) return {};
  try { const p = JSON.parse(text || "{}"); return isRecord(p) ? p : {}; } catch { return {}; }
}

/* ---------------------------------------------------------------- /api/auth/* */

export async function authApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const rpID = url.hostname;
  const origin = url.origin;
  if (method !== "GET" && request.headers.get("origin") !== origin) return refuse(403, "forbidden", "Untrusted origin.");
  if (env.PER_IP) {
    const rl = await env.PER_IP.limit({ key: `auth:${rateLimitIpKey(request.headers.get("cf-connecting-ip"))}` });
    if (!rl.success) return refuse(429, "rate_limited", "Too many attempts. Try again in a moment.");
  }

  if (path === "/api/auth/state" && method === "GET") {
    const operator = await verifyOperator(request, env);
    return json({ authenticated: Boolean(operator) }, 200, operator?.renewed ? { "set-cookie": operator.renewed } : {});
  }

  if (path === "/api/auth/register/options" && method === "POST") {
    const b = await body(request);
    const codeHash = await openEnrollment(env, b.code);
    if (!codeHash) return refuse(403, "enrollment_invalid", "This device link is no longer valid. Ask for a new one from a device that is already signed in.");
    const existing = await env.DB.prepare("SELECT id, transports FROM operator_passkeys").all<{ id: string; transports: string }>();
    const options = await generateRegistrationOptions({
      rpName: "Cloudflare SaaS Analytics", rpID, userName: env.OPERATOR_NAME || "Operator", userID: new Uint8Array(utf8("saas-analytics-operator")) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      excludeCredentials: (existing.results ?? []).map((c) => ({ id: c.id, transports: JSON.parse(c.transports) as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -8, -257],
    });
    const challengeId = await storeChallenge(env, options.challenge, "register", codeHash);
    return json({ challengeId, options });
  }

  if (path === "/api/auth/register/verify" && method === "POST") {
    const b = await body(request);
    const ch = await takeChallenge(env, b.challengeId, "register");
    if (!ch?.code_hash) return refuse(403, "challenge_invalid", "The request has expired. Try again.");
    let verified;
    try {
      verified = await verifyRegistrationResponse({ response: b.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) {
      console.warn(JSON.stringify({ event: "passkey_registration_refused", reason: String((e as Error)?.message ?? e).slice(0, 200) }));
      return refuse(400, "registration_failed", "The passkey could not be verified. Try again.");
    }
    if (!verified.verified || !verified.registrationInfo) return refuse(400, "registration_failed", "The passkey could not be verified. Try again.");
    /* The code is consumed by exactly one registration, checked again here. */
    const used = await env.DB.prepare("UPDATE operator_enrollments SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(new Date().toISOString(), ch.code_hash, Date.now()).run();
    if (used.meta.changes !== 1) return refuse(403, "enrollment_invalid", "This device link has already been used.");
    const cred = verified.registrationInfo.credential;
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 60) : deviceLabel(request);
    await env.DB.prepare("INSERT INTO operator_passkeys (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(cred.id, b64url(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), label, new Date().toISOString()).run();
    return json({ ok: true }, 201, { "set-cookie": await openSession(env, request, cred.id) });
  }

  if (path === "/api/auth/login/options" && method === "POST") {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [] });
    const challengeId = await storeChallenge(env, options.challenge, "login", null);
    return json({ challengeId, options });
  }

  if (path === "/api/auth/login/verify" && method === "POST") {
    const b = await body(request);
    const ch = await takeChallenge(env, b.challengeId, "login");
    if (!ch) return refuse(403, "challenge_invalid", "The request has expired. Try again.");
    const response = b.response as AuthenticationResponseJSON;
    const cred = typeof response?.id === "string"
      ? await env.DB.prepare("SELECT id, public_key, counter, transports FROM operator_passkeys WHERE id = ?").bind(response.id).first<{ id: string; public_key: string; counter: number; transports: string }>()
      : null;
    if (!cred) return refuse(403, "unknown_passkey", "This passkey is not registered for Cloudflare SaaS Analytics.");
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(fromB64url(cred.public_key)) as Uint8Array<ArrayBuffer>, counter: cred.counter, transports: JSON.parse(cred.transports) },
      });
    } catch (e) {
      console.warn(JSON.stringify({ event: "passkey_login_refused", reason: String((e as Error)?.message ?? e).slice(0, 200) }));
      return refuse(403, "login_failed", "The passkey was not accepted.");
    }
    if (!verified.verified) return refuse(403, "login_failed", "The passkey was not accepted.");
    await env.DB.prepare("UPDATE operator_passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(verified.authenticationInfo.newCounter, new Date().toISOString(), cred.id).run();
    return json({ ok: true }, 200, { "set-cookie": await openSession(env, request, cred.id) });
  }

  /* Everything below needs a session, and the anti-CSRF token for writes. */
  const operator = await verifyOperator(request, env);
  if (!operator) return refuse(401, "unauthenticated", "Sign in with your passkey.");
  if (method !== "GET" && !(await csrfOk(request, env, operator))) return refuse(403, "forbidden", "This request did not come from the dashboard. Reload the page.");

  if (path === "/api/auth/logout" && method === "POST") {
    if (operator.sessionId) await env.DB.prepare("UPDATE operator_sessions SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), operator.sessionId).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(url, "", 0) });
  }
  if (path === "/api/auth/devices" && method === "GET") {
    const sessions = await env.DB.prepare("SELECT id, label, created_at, last_seen_at FROM operator_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC").bind(Date.now()).all();
    const passkeys = await env.DB.prepare("SELECT id, label, created_at, last_used_at FROM operator_passkeys ORDER BY created_at ASC").all();
    return json({ current: operator.sessionId, sessions: sessions.results ?? [], passkeys: passkeys.results ?? [] });
  }
  if (path === "/api/auth/enroll" && method === "POST") {
    const code = await createEnrollment(env, operator.actor, 15);
    return json({ url: `${origin}/?enroll=${code}`, expiresInMinutes: 15 }, 201);
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/api\/auth\/sessions\/(os_[A-Za-z0-9]+)$/.exec(path)) && method === "DELETE") {
    await env.DB.prepare("UPDATE operator_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), m[1]).run();
    return json({ ok: true });
  }
  if ((m = /^\/api\/auth\/passkeys\/([A-Za-z0-9_-]{8,256})$/.exec(path)) && method === "DELETE") {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_passkeys").first<{ n: number }>();
    if ((count?.n ?? 0) <= 1) return refuse(409, "last_passkey", "This is the last passkey: removing it would lock you out of Cloudflare SaaS Analytics. Add another device first.");
    /* A lost phone: its passkey goes, and every session it opened with it. */
    await env.DB.batch([
      env.DB.prepare("DELETE FROM operator_passkeys WHERE id = ?").bind(m[1]),
      env.DB.prepare("UPDATE operator_sessions SET revoked_at = ? WHERE passkey_id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), m[1]),
    ]);
    return json({ ok: true });
  }
  return refuse(404, "not_found", "No such endpoint.");
}
