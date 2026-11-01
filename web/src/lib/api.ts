/* The operator API (src/operator/api.ts): same origin, passkey session cookie, CSRF header on writes. */
let csrf = "";
export const setCsrf = (token: string) => { csrf = token; };

export class Unauthenticated extends Error {}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(csrf ? { "x-csa-csrf": csrf } : {}), ...(init?.headers ?? {}) } });
  if (res.status === 401) { window.dispatchEvent(new Event("csa:signed-out")); throw new Unauthenticated(); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? (res.status >= 500 ? "The server could not answer. Try again in a moment." : `Error ${res.status}`));
  return body as T;
}

export type Product = { id: string; name: string; domain: string };
export type Me = { csrf: string; operator: string; ai?: boolean; products: Product[] };
/** Optional features the server reports at sign-in (set once from /api/me). */
export const features = { ai: false };
export const NUMS = ["views", "visitors", "visits", "bounces", "engaged_ms", "returning_visitors", "signups", "events", "bot_views", "revenue_cents"] as const;
export type Num = (typeof NUMS)[number];
export type Totals = Record<Num, number>;
export type Point = Totals & { day: string; live: boolean };
export type Top = { k: string; views?: number; visits?: number; visitors?: number; count?: number; users?: number };
