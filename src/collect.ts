/*
  POST https://t.<product domain>/e   (the tracker, public/t.js)

  Body (text/plain JSON, so no CORS preflight): { c: consent 1|0|null, k?: user token, e: [hit] }
  hit: { n: event name, u: page URL, r: referrer, ts, lang, sw, sh, vw, vh, wd, em, sp, lcp, inp, cls, p: props }

  Everything a visitor can send is bounded: 32 KB per request, 25 hits, known keys only, string
  lengths capped, and a rate limit per IP and per product (wrangler.jsonc `ratelimits`). The answer
  is always 204 so a script on a site never learns anything from it.
*/
import { classify, hostOf, pathOf } from "./channels";
import type { Env } from "./env";
import { rateLimitIpKey, readBoundedText } from "./http-security";
import { anonCookie, ANON_COOKIE, dayHash, newAnon, readCookie, validAnon, verifyUser } from "./identity";
import { ownsHost, type Product } from "./products";
import { isCrawlerUA, isDatacenterASN, parseUA } from "./ua";
import { cleanProps, eventName } from "./events";

export type Hit = {
  n?: unknown; u?: unknown; r?: unknown; ts?: unknown; lang?: unknown;
  sw?: unknown; sh?: unknown; vw?: unknown; vh?: unknown; wd?: unknown;
  em?: unknown; sp?: unknown; lcp?: unknown; inp?: unknown; cls?: unknown; p?: unknown;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown, min: number, max: number) => {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const flt = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 1000) / 1000 : null);
const bucket = (w: number | null, h: number | null) => (w && h ? `${Math.round(w / 10) * 10}x${Math.round(h / 10) * 10}` : "");

export function corsHeaders(origin: string | null, p: Product): Record<string, string> {
  const host = origin ? hostOf(origin.replace(/^(https?:\/\/)www\./, "$1")) : "";
  const ok = origin && (ownsHost(p, host) || ownsHost(p, hostOf(origin)));
  return ok
    ? { "access-control-allow-origin": origin!, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csa-user", "access-control-allow-methods": "POST, GET, OPTIONS", "vary": "origin" }
    : {};
}

export type Enriched = Record<string, string | number | boolean | null | undefined>;

/** Request facts shared by every hit of a request. */
export async function requestFacts(req: Request, env: Env, p: Product, now: number) {
  const cf = (req as unknown as { cf?: IncomingRequestCfProperties }).cf;
  const ua = req.headers.get("user-agent") ?? "";
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  const dnt = req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1";
  const verified = (cf as unknown as { verifiedBotCategory?: string })?.verifiedBotCategory ?? "";
  const crawler = isCrawlerUA(ua);
  const asn = typeof cf?.asn === "number" ? cf.asn : null;
  const device = parseUA(ua, { mobile: req.headers.get("sec-ch-ua-mobile"), platform: req.headers.get("sec-ch-ua-platform") });
  const langs = (req.headers.get("accept-language") ?? "").split(",").map((s) => s.split(";")[0]!.trim().toLowerCase()).filter(Boolean).slice(0, 3).join(",");
  const bot = verified ? `verified:${verified}` : crawler ? "user_agent" : "";
  return {
    ua, ip, dnt, bot, device, langs,
    geo: {
      country: (cf?.country as string) ?? "", region: (cf?.region as string) ?? "", city: (cf?.city as string) ?? "",
      continent: (cf?.continent as string) ?? "", timezone: (cf?.timezone as string) ?? "",
      asn, as_org: ((cf?.asOrganization as string) ?? "").slice(0, 80), is_datacenter: isDatacenterASN(asn),
    },
    day_hash: !dnt && !bot ? await dayHash(env, p.id, ip, ua, now) : null,
  };
}

export async function handleCollect(req: Request, env: Env, ctx: ExecutionContext, p: Product): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), p);
  const done = (headers: Record<string, string> = {}) => new Response(null, { status: 204, headers: { ...cors, ...headers, "cache-control": "no-store" } });
  if (!cors["access-control-allow-origin"]) return done();

  const ipKey = rateLimitIpKey(req.headers.get("cf-connecting-ip"));
  const [a, b] = await Promise.all([env.PER_IP.limit({ key: ipKey }), env.PER_PRODUCT.limit({ key: p.id })]);
  if (!a.success || !b.success) return done();
  if (await killed(env, p.id)) return done();

  const text = await readBoundedText(req, 32 * 1024);
  if (text === null) return done();
  let body: { c?: unknown; k?: unknown; e?: unknown };
  try { body = JSON.parse(text); } catch { return done(); }
  const hits = Array.isArray(body.e) ? (body.e as Hit[]).slice(0, 25) : [];
  if (!hits.length) return done();

  const now = Date.now();
  const f = await requestFacts(req, env, p, now);
  const user = await verifyUser(env, body.k, p.id);

  /* Consent cookie: set on an explicit yes (c === 1), cleared on a no (c === 0), never read into
     records when consent is missing/declined or DNT/GPC/bot is active. */
  const setCookie: string[] = [];
  const rawAnon = validAnon(readCookie(req.headers.get("cookie"), ANON_COOKIE));
  let anon: string | null = null;
  if (body.c === 1 && !f.dnt && !f.bot) {
    anon = rawAnon ?? newAnon();
    setCookie.push(anonCookie(p.domain, anon));
  } else if (body.c === 0 && rawAnon) {
    setCookie.push(anonCookie(p.domain, "", 0));
  }

  const records: Enriched[] = [];
  const entries: { ident: string[]; touch: Enriched }[] = [];
  for (const h of hits) {
    const name = eventName(h.n);
    const url = str(h.u, 1000);
    const host = hostOf(url);
    if (!name || !host || !ownsHost(p, host)) continue;
    const t = classify(url, str(h.r, 1000), p.domain);
    const ts = int(h.ts, now - 24 * 3600_000, now + 60_000) ?? now;
    const rec: Enriched = {
      ts, received_at: now, schema: 1, product: p.id, host, surface: surfaceOf(host, p), event: name, origin: "web",
      level: user ? 2 : anon ? 1 : 0,
      day_hash: f.day_hash, anon_id: anon, user_id: user?.u ?? null, workspace_id: user?.w ?? null, visit_id: null, session_id: null,
      path: pathOf(url), referrer_host: t.referrer_host, referrer_path: t.referrer_host ? pathOf(str(h.r, 1000)) : "",
      channel: t.channel, ai_source: t.ai_source,
      utm_source: t.utm_source, utm_medium: t.utm_medium, utm_campaign: t.utm_campaign, utm_content: t.utm_content, utm_term: t.utm_term, click_id_kind: t.click_id_kind,
      ...f.geo,
      lang: str(h.lang, 20).toLowerCase(), langs: f.langs,
      ...f.device,
      screen: bucket(int(h.sw, 100, 10000), int(h.sh, 100, 10000)), viewport: bucket(int(h.vw, 100, 10000), int(h.vh, 100, 10000)),
      engaged_ms: int(h.em, 0, 6 * 3600_000), scroll_pct: int(h.sp, 0, 100),
      lcp_ms: flt(h.lcp, 120_000), inp_ms: flt(h.inp, 60_000), cls: flt(h.cls, 100),
      is_bot: Boolean(f.bot) || h.wd === 1, bot_reason: f.bot || (h.wd === 1 ? "webdriver" : ""),
      props: name.startsWith("$") ? null : cleanProps(h.p),
    };
    records.push(rec);
    /* Remember the first external landing of each identity (3-day TTL in D1) for signup attribution. */
    const consentLanding = name === "$consent" && anon;
    if ((name === "$pageview" || consentLanding) && t.channel !== "Internal" && !rec.is_bot) {
      const ident = (consentLanding ? [`a:${anon}`] : [f.day_hash ? `h:${f.day_hash}` : "", anon ? `a:${anon}` : ""]).filter(Boolean);
      if (ident.length) entries.push({ ident, touch: { channel: t.channel, ai_source: t.ai_source, referrer_host: t.referrer_host, utm_source: t.utm_source, utm_medium: t.utm_medium, utm_campaign: t.utm_campaign, entry_path: rec.path, host, country: f.geo.country, at: new Date(ts).toISOString() } });
    }
  }
  if (records.length) ctx.waitUntil(write(env, p, records, entries, anon, now));
  const res = done();
  for (const c of setCookie) res.headers.append("set-cookie", c);
  return res;
}

export function surfaceOf(host: string, p: Product): string {
  if (host.startsWith("app.") || host.startsWith("studio.") || host.startsWith("dashboard.")) return "app";
  if (host.startsWith("docs.")) return "docs";
  return host === p.domain || host === `www.${p.domain}` ? "website" : host.split(".")[0] ?? "other";
}

const IDENT_CACHE_TTL = 15 * 60_000;
const seenByDb = new WeakMap<object, Map<string, number>>();
function identCache(db: object): Map<string, number> {
  let m = seenByDb.get(db);
  if (!m) seenByDb.set(db, (m = new Map()));
  return m;
}

async function write(env: Env, p: Product, records: Enriched[], entries: { ident: string[]; touch: Enriched }[], anon: string | null, now: number) {
  try {
    await env.STREAM.send(records);
  } catch (e) {
    console.error(JSON.stringify({ event: "stream_send_failed", product: p.id, n: records.length, reason: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
  if (!entries.length) return;
  const seen = identCache(env.DB);
  const byIdent = new Map<string, Enriched>();
  for (const e of entries) {
    for (const ident of e.ident) if (!byIdent.has(ident)) byIdent.set(ident, e.touch);
  }
  const stmts: D1PreparedStatement[] = [];
  const writtenKeys: string[] = [];
  for (const [ident, touch] of byIdent) {
    const cacheKey = `rv:${p.id}:${ident}`;
    const cachedAt = seen.get(cacheKey);
    if (cachedAt && now - cachedAt < IDENT_CACHE_TTL) continue;
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO recent_visits (product, ident, started_at, touch) VALUES (?, ?, ?, ?)").bind(p.id, ident, now, JSON.stringify(touch)));
    writtenKeys.push(cacheKey);
  }
  if (anon) {
    const anonKey = `af:${p.id}:${anon}`;
    const cachedAt = seen.get(anonKey);
    if (!cachedAt || now - cachedAt >= IDENT_CACHE_TTL) {
      const first = entries[0]!.touch;
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO anon_first (product, anon_id, first_day, first_touch) VALUES (?, ?, ?, ?)").bind(p.id, anon, new Date(now).toISOString().slice(0, 10), JSON.stringify(first)));
      writtenKeys.push(anonKey);
    }
  }
  if (!stmts.length) return;
  try {
    await env.DB.batch(stmts.slice(0, 20));
    if (seen.size > 5000) {
      for (const [k, at] of seen) if (now - at >= IDENT_CACHE_TTL) seen.delete(k);
      if (seen.size > 5000) seen.clear();
    }
    for (const k of writtenKeys) seen.set(k, now);
  } catch (e) {
    console.error(JSON.stringify({ event: "recent_visit_failed", product: p.id, reason: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
}

const killCache = new Map<string, { at: number; off: boolean }>();
/** Per-product kill switch in KV (`kill:<product>` = "1", or `kill:*`), cached 60 s per isolate. */
export async function killed(env: Env, product: string): Promise<boolean> {
  if (env.COLLECT === "off") return true;
  const hit = killCache.get(product);
  if (hit && Date.now() - hit.at < 60_000) return hit.off;
  const [one, all] = await Promise.all([env.KV.get(`kill:${product}`, { cacheTtl: 60 }), env.KV.get("kill:*", { cacheTtl: 60 })]);
  const off = one === "1" || all === "1";
  killCache.set(product, { at: Date.now(), off });
  return off;
}
