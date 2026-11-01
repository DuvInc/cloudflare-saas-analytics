/*
  saas-analytics: one Worker, two faces.

  On a product's collection host (t.<domain>, custom domain): the tracker (/t.js, /replay.js) and
  its two doors (/e page and product events, /r replay chunks). Nothing else answers there.
  On workers.dev: the private dashboard (passkey), the Stripe webhooks (/stripe/<product>) and
  POST /s for server events from what is not a Worker. Everything says noindex.

  Crons (UTC): hourly at :17 rollups + health alerts; 03:17 Stripe reconciliation; 07:17 reports.
  Spend: Spend Guard prices and pauses this Worker like any other. Basin ingestion is only fed
  from here (its HTTP endpoint is off), so pausing the Worker stops it too. Kill switch without
  a deploy: KV `kill:<product>` or `kill:*` = "1" (`csa kill`), or var COLLECT = "off".
*/
import type { Env } from "./env";
import { handleCollect, corsHeaders } from "./collect";
import { handleReplay } from "./replay";
import { handleStripeWebhook, reconcileStripe } from "./stripe";
import { runBots } from "./bots";
import { runRollups } from "./rollup";
import { sendAlerts, sendReportNow, sendReports } from "./report";
import { productByCollectHost, productById, products } from "./products";
import { serverTrack, identify, reconcileSignups } from "./rpc";
import { authApi, verifyOperator } from "./operator/auth";
import { operatorApi } from "./operator/api";
import { timingSafeEqual } from "./crypto";
import { operatorSecurityHeaders, rateLimitIpKey, readBoundedText } from "./http-security";

export { AnalyticsService } from "./rpc";

const NOINDEX = { "x-robots-tag": "noindex, nofollow, noarchive", "x-content-type-options": "nosniff" };

function withHeaders(res: Response, headers: Record<string, string>) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const product = productByCollectHost(env.PRODUCTS, url.hostname);

    if (product) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...corsHeaders(request.headers.get("origin"), product), "access-control-max-age": "86400" } });
      if (request.method === "POST" && url.pathname === "/e") return handleCollect(request, env, ctx, product);
      if (request.method === "POST" && url.pathname === "/r") return handleReplay(request, env, product);
      if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/t.js" || url.pathname === "/replay.js")) {
        const res = await env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin), request));
        /* An hour fresh, then served from the browser cache while it revalidates: a new version
           reaches everyone within the hour, and no page view ever waits for the script. */
        return withHeaders(res, { ...NOINDEX, "cache-control": "public, max-age=3600, stale-while-revalidate=604800", "access-control-allow-origin": "*" });
      }
      if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain", ...NOINDEX } });
      return new Response("Not found", { status: 404, headers: NOINDEX });
    }

    let m: RegExpExecArray | null;
    if (request.method === "POST" && (m = /^\/stripe\/([a-z0-9-]+)$/.exec(url.pathname))) return handleStripeWebhook(request, env, m[1]!);
    if (request.method === "POST" && url.pathname === "/s") return withHeaders(await serverEvents(request, env), NOINDEX);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain", ...NOINDEX } });

    const secHeaders = operatorSecurityHeaders(env.PRODUCTS);
    if (url.pathname.startsWith("/api/auth/")) return withHeaders(await authApi(request, env), secHeaders);
    if (url.pathname.startsWith("/api/")) return withHeaders(await operatorApi(request, env), secHeaders);
    if (url.pathname === "/t.js" || url.pathname === "/replay.js") return new Response("Not found", { status: 404, headers: NOINDEX });

    /* Private operator assets (APK, replay player, internal product icons): require an operator session. */
    const privateAsset = url.pathname.startsWith("/android/") || url.pathname === "/player.js" || url.pathname === "/player.css" || url.pathname.startsWith("/products/");
    if (privateAsset) {
      const op = await verifyOperator(request, env);
      if (!op) return new Response("Unauthorized", { status: 401, headers: { ...secHeaders, "cache-control": "private, no-store" } });
    }

    const res = await env.ASSETS.fetch(request);
    /* Built files carry their hash in the name: cached for good. Fonts and icons: a day. Private assets: private cache. */
    const cache = privateAsset ? "private, max-age=3600"
      : url.pathname.startsWith("/app/") ? "public, max-age=31536000, immutable"
      : /^\/(fonts|icons)\//.test(url.pathname) || url.pathname === "/favicon.svg" || url.pathname === "/theme.js" ? "public, max-age=86400, stale-while-revalidate=604800" : null;
    return withHeaders(res, { ...secHeaders, ...(cache && res.ok ? { "cache-control": cache } : {}) });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const hour = new Date(controller.scheduledTime).getUTCHours();
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try { const r = await fn(); console.log(JSON.stringify({ event: "cron_step", name, result: r })); }
      catch (e) { console.error(JSON.stringify({ event: "cron_step_failed", name, reason: String((e as Error)?.message ?? e).slice(0, 300) })); }
    };
    await step("signups", () => reconcileSignups(env, products(env.PRODUCTS)));
    await step("rollup", () => runRollups(env, controller.scheduledTime));
    await step("bots", () => runBots(env, controller.scheduledTime));
    if (hour === 3) await step("stripe", () => reconcileStripe(env));
    /* At 07:17 the scheduled reports; any hour, a report asked with `csa report <kind>`. */
    if (hour === 7) await step("reports", () => sendReports(env, controller.scheduledTime));
    else await step("report_asked", async () => { const k = await env.KV.get("report:now"); return k ? sendReportNow(env, k as "daily", controller.scheduledTime).then((ok) => env.KV.delete("report:now").then(() => ok)) : null; });
    await step("alerts", () => sendAlerts(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

/* POST /s  Authorization: Bearer <token of the product>  { product, type: "track"|"identify", ... } */
async function serverEvents(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ") || authHeader.length < 16 || authHeader.length > 512) {
    return new Response("unauthorized", { status: 401 });
  }
  if (env.PER_IP) {
    const rl = await env.PER_IP.limit({ key: `s:${rateLimitIpKey(request.headers.get("cf-connecting-ip"))}` });
    if (!rl.success) return new Response("rate limited", { status: 429 });
  }
  const tokens = JSON.parse(env.SERVER_TOKENS ?? "{}") as Record<string, string>;
  const auth = authHeader.slice(7);
  const text = await readBoundedText(request, 32 * 1024);
  if (text === null) return new Response("too large", { status: 413 });
  let b: Record<string, any>;
  try { b = JSON.parse(text); } catch { return new Response("bad json", { status: 400 }); }
  const p = typeof b.product === "string" ? productById(env.PRODUCTS, b.product) : null;
  if (!p || !tokens[p.id] || !auth || !timingSafeEqual(auth, tokens[p.id]!)) return new Response("unauthorized", { status: 401 });
  if (b.type === "identify") return Response.json(await identify(env, p, b as any));
  return Response.json({ ok: await serverTrack(env, p, b as any) });
}
