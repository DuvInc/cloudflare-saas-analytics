/*
  Who a hit belongs to, by level (PLAN.md §2):
   0  day hash: SHA-256(salt of the UTC day, product, IP, UA), first 16 bytes. The salt lives 48 h
      in KV and is never exported, so yesterday's hashes cannot be recomputed after it expires.
      Nothing is stored on or read from the device.
   1  `csa_id`: a first-party cookie set by this Worker on the product's domain, only with consent.
   2  user token: signed by this Worker for a product's signed-in user (RPC `userToken`), carried by
      the page. The browser never chooses its own user id.
*/
import { b64url, fromB64url, hmacB64url, timingSafeEqual } from "./crypto";
import type { Env } from "./env";

const SALT_TTL = 48 * 3600;
const saltCache = new Map<string, string>();

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function salt(env: Env, day: string, create: boolean): Promise<string | null> {
  const hit = saltCache.get(day);
  if (hit) return hit;
  const key = `salt:${day}`;
  let value = await env.KV.get(key);
  if (!value && create) {
    value = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.KV.put(key, value, { expirationTtl: SALT_TTL });
    /* Two isolates may race on a new day: read back so both use the stored one. */
    value = (await env.KV.get(key)) ?? value;
  }
  if (value) {
    if (saltCache.size > 4) saltCache.clear();
    saltCache.set(day, value);
  }
  return value;
}

export async function dayHash(env: Env, product: string, ip: string, ua: string, ms = Date.now(), create = true): Promise<string | null> {
  if (!ip) return null;
  const s = await salt(env, utcDay(ms), create);
  if (!s) return null;
  const data = new TextEncoder().encode(`${s}\u0000${product}\u0000${ip}\u0000${ua}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------------------------------------------------------- consent cookie */

export const ANON_COOKIE = "csa_id";
export const ANON_MAX_AGE = 395 * 24 * 3600; // 13 months, the CNIL ceiling

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
export const validAnon = (v: string | null) => (v && /^a_[A-Za-z0-9_-]{20,40}$/.test(v) ? v : null);
export const newAnon = () => `a_${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;

export function anonCookie(domain: string, value: string, maxAge = ANON_MAX_AGE): string {
  return `${ANON_COOKIE}=${value}; Domain=${domain}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/* ---------------------------------------------------------------- user tokens */

export type UserClaims = { p: string; u: string; w?: string; exp: number };
const TOKEN_DAYS = 7;

export async function signUser(env: Env, product: string, userId: string, workspaceId?: string | null): Promise<string> {
  if (!env.IDENTITY_SECRET) throw new Error("IDENTITY_SECRET is not set");
  const claims: UserClaims = { p: product, u: userId, ...(workspaceId ? { w: workspaceId } : {}), exp: Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400 };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `u1.${payload}.${await hmacB64url(env.IDENTITY_SECRET, `u1.${payload}`)}`;
}

export async function verifyUser(env: Env, token: unknown, product: string): Promise<UserClaims | null> {
  if (typeof token !== "string" || token.length > 600 || !env.IDENTITY_SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "u1") return null;
  const expected = await hmacB64url(env.IDENTITY_SECRET, `u1.${parts[1]}`);
  if (!timingSafeEqual(parts[2]!, expected)) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as UserClaims;
    if (c.p !== product || typeof c.u !== "string" || c.exp < Date.now() / 1000) return null;
    return c;
  } catch { return null; }
}
