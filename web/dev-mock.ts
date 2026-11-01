/*
  Local preview only (`MOCK=1 npm run dev:web`): answers /api with made-up but believable data, so
  the screens can be reviewed without a passkey. Never part of the build.
*/
import { readFileSync, existsSync } from "node:fs";
import type { Plugin } from "vite";

const PUBLIC = new URL("../public/", import.meta.url);
const TYPES: Record<string, string> = { woff2: "font/woff2", png: "image/png", js: "text/javascript", css: "text/css", webmanifest: "application/manifest+json", svg: "image/svg+xml" };

const DAY = 86400_000;
const utc = (t: number) => new Date(t).toISOString().slice(0, 10);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const NUMS = ["views", "visitors", "visits", "bounces", "engaged_ms", "returning_visitors", "signups", "events", "bot_views", "revenue_cents"];

function series(days: number, base: number, start: number) {
  let drift = 0, spike = 0;
  const weekend = 0.5 + rnd();          // how much this product dips at weekends
  const growth = 0.15 + rnd() * 0.6;    // how fast it grows over the period
  return Array.from({ length: days }, (_, i) => {
    const t = start + i * DAY;
    const wk = 1 + ([0.72, 1, 1.08, 1.06, 1.02, 0.92, 0.68][new Date(t).getUTCDay()]! - 1) * weekend;
    drift = drift * 0.8 + (rnd() - 0.5) * 0.24;                 // slow wander, so days are not independent
    spike = rnd() < 0.06 ? 0.5 + rnd() * 0.9 : spike * 0.45;    // now and then a post gets picked up, then fades
    const visitors = Math.max(1, Math.round(base * wk * (1 + (i / days) * growth) * (1 + drift) * (1 + spike) * (0.94 + rnd() * 0.12)));
    const visits = Math.round(visitors * (1.2 + rnd() * 0.1));
    const signups = Math.round(visitors * 0.034 * (0.7 + rnd() * 0.6));
    return { day: utc(t), live: i === days - 1, visitors, visits, views: Math.round(visits * (2.4 + rnd() * 0.4)), bounces: Math.round(visits * (0.38 + rnd() * 0.08)), engaged_ms: visits * Math.round(52_000 + rnd() * 18_000),
      returning_visitors: Math.round(visitors * (0.15 + rnd() * 0.06)), signups, events: visits * 3, bot_views: Math.round(visitors * (0.15 + rnd() * 0.1)),
      revenue_cents: rnd() > 0.45 ? Math.max(1, Math.round(signups * 0.45 * (0.5 + rnd()))) * 2900 : 0 };
  });
}
const totals = (s: any[]) => Object.fromEntries(NUMS.map((k) => [k, s.reduce((a, r) => a + r[k], 0)]));
const tops = {
  channels: [["Organic Search", 812, 640], ["Direct", 540, 488], ["AI", 214, 190], ["Referral", 160, 141], ["Organic Social", 95, 88], ["Email", 31, 30]].map(([k, visits, visitors]) => ({ k, visits, visitors })),
  referrers: [["google.com", 790], ["chatgpt.com", 151], ["perplexity.ai", 38], ["linkedin.com", 64], ["news.ycombinator.com", 41], ["bing.com", 22], ["claude.ai", 17], ["reddit.com", 14], ["duckduckgo.com", 12], ["x.com", 9]].map(([k, visits]) => ({ k, visits })),
  ai_sources: [["ChatGPT", 151], ["Perplexity", 38], ["Claude", 17], ["Gemini", 6], ["Copilot", 2]].map(([k, visits]) => ({ k, visits })),
  utm_sources: [["newsletter", 31], ["linkedin", 24]].map(([k, visits]) => ({ k, visits })),
  utm_campaigns: [["launch-october", 40]].map(([k, visits]) => ({ k, visits })),
  pages: [["/", 1840, 1020], ["/pricing", 610, 455], ["/integrations", 402, 290], ["/blog/ab-testing-guide", 377, 340], ["/sign-up", 290, 260], ["/docs/getting-started", 188, 120], ["/blog/saas-metrics-guide", 160, 150], ["/features/reports", 121, 99], ["/about", 70, 66], ["/legal/privacy", 18, 17]].map(([k, views, visitors]) => ({ k, views, visitors })),
  entries: [["/", 920], ["/blog/ab-testing-guide", 330], ["/pricing", 210], ["/integrations", 140], ["/blog/saas-metrics-guide", 138]].map(([k, visits]) => ({ k, visits })),
  countries: [["DE", 610], ["FR", 402], ["US", 233], ["GB", 120], ["NL", 66], ["CH", 41], ["BE", 39], ["ES", 22], ["IT", 20], ["CA", 15]].map(([k, visitors]) => ({ k, visitors })),
  cities: [["Berlin", 344], ["Paris", 190], ["Hamburg", 77], ["München", 70], ["London", 66], ["Lyon", 41]].map(([k, visitors]) => ({ k, visitors })),
  langs: [["de", 640], ["fr", 410], ["en", 520], ["nl", 40]].map(([k, visitors]) => ({ k, visitors })),
  devices: [["desktop", 980], ["mobile", 610], ["tablet", 32]].map(([k, visitors]) => ({ k, visitors })),
  browsers: [["Chrome", 900], ["Safari", 450], ["Firefox", 120], ["Edge", 90], ["Samsung Internet", 30]].map(([k, visitors]) => ({ k, visitors })),
  os: [["macOS", 610], ["Windows", 420], ["iOS", 390], ["Android", 210]].map(([k, visitors]) => ({ k, visitors })),
  custom_events: [["project_created", 64, 51], ["onboarding_completed", 48, 48], ["report_published", 21, 19], ["integration_connected", 7, 7], ["checkout_started", 9, 8]].map(([k, count, users]) => ({ k, count, users })),
};
const PRODUCTS = [{ id: "acme", name: "Acme", domain: "acme.com" }, { id: "northwind", name: "Northwind", domain: "northwind.app" }, { id: "fabrikam", name: "Fabrikam", domain: "fabrikam.io" }, { id: "contoso", name: "Contoso", domain: "contoso.app" }, { id: "lumen", name: "Lumen", domain: "lumen.club" }, { id: "fjord", name: "Fjord", domain: "fjord.dev" }];
const PEOPLE = [
  ["lena.hoffmann@example.de", "Lena Hoffmann", "Organic Search", null, "pro", 5800], ["marc.dubois@example.fr", "Marc Dubois", "AI", "ChatGPT", "starter", 2900],
  ["sofia.rossi@example.com", null, "Direct", null, null, 0], ["j.becker@example.org", "Jonas Becker", "AI", "Perplexity", "starter", 2900],
  ["claire@example.net", "Claire Martin", "Referral", null, null, 0], ["tom.w@example.com", null, "Organic Social", null, null, 0],
].map(([email, name, channel, ai_source, plan, ltv], i) => ({ product: i % 3 === 2 ? "northwind" : "acme", user_id: `usr_${1000 + i}`, email, name, plan, created_at: new Date(Date.now() - i * 2.3 * DAY).toISOString(), last_seen_at: new Date(Date.now() - i * 3600_000).toISOString(), ltv_cents: ltv, currency: "eur", attribution_method: i % 2 ? "hash" : "cookie", channel, ai_source, referrer_host: ai_source === "ChatGPT" ? "chatgpt.com" : null }));

/* A believable app screen for the replay player: a sidebar, a list of projects, a cursor that goes to "New project" and clicks. */
function replayEvents() {
  let id = 10;
  const T = (textContent: string) => ({ type: 3, id: id++, textContent });
  const E = (tagName: string, style: string, childNodes: any[] = []) => ({ type: 2, id: id++, tagName, attributes: { style }, childNodes });
  const nav = (label: string, active = false) => E("div", `padding:8px 12px;border-radius:8px;font-size:14px;${active ? "background:#ececec;font-weight:600;color:#171717" : "color:#525252"}`, [T(label)]);
  const badge = (label: string, live: boolean) => E("span", `font-size:12px;padding:2px 8px;border-radius:999px;${live ? "background:#dcfce7;color:#15803d" : "background:#f0f0f0;color:#525252"}`, [T(label)]);
  const row = (name: string, status: string, live: boolean, updated: string) => E("div", "display:flex;align-items:center;padding:16px 0;border-top:1px solid #ececec;font-size:15px", [
    E("div", "flex:1;font-weight:500;color:#171717", [T(name)]), E("div", "width:120px", [badge(status, live)]), E("div", "width:160px;color:#737373;font-size:14px", [T(updated)])]);
  const button = E("div", "background:#171717;color:#fff;padding:9px 16px;border-radius:8px;font-size:14px;font-weight:500", [T("New project")]);
  const html = E("html", "", [E("body", "margin:0;font-family:Inter,system-ui,sans-serif;background:#fff", [
    E("div", "display:flex;height:900px", [
      E("aside", "width:240px;background:#fafafa;border-right:1px solid #ececec;padding:24px 16px", [
        E("div", "font-weight:700;font-size:17px;margin:0 12px 24px;color:#171717", [T("Fabrikam")]),
        nav("Projects", true), nav("Reports"), nav("Team"), nav("Integrations"), nav("Billing")]),
      E("main", "flex:1;padding:40px 48px", [
        E("div", "display:flex;justify-content:space-between;align-items:center;margin-bottom:28px", [E("div", "font-size:26px;font-weight:650;color:#171717", [T("Projects")]), button]),
        E("div", "font-size:13px;color:#737373;display:flex;padding-bottom:10px", [E("div", "flex:1", [T("Name")]), E("div", "width:120px", [T("Status")]), E("div", "width:160px", [T("Updated")])]),
        row("Q4 pipeline report", "Live", true, "2 hours ago"), row("Onboarding funnel", "Live", true, "Yesterday"),
        row("Churn analysis", "Draft", false, "3 days ago"), row("Pricing experiment", "Draft", false, "Last week"), row("Customer interviews", "Live", true, "Oct 21")])])])]);
  const node = { type: 0, id: 1, childNodes: [{ ...html, id: 2 }] };
  const t = Date.now() - 60_000;
  const path = (pts: [number, number][], at: number) => ({ type: 3, data: { source: 1, positions: pts.map(([x, y], k) => ({ x, y, id: button.id, timeOffset: k * 120 - pts.length * 120 })) }, timestamp: t + at });
  return [
    { type: 4, data: { href: "https://app.fabrikam.io/projects", width: 1440, height: 900 }, timestamp: t },
    { type: 2, data: { node, initialOffset: { top: 0, left: 0 } }, timestamp: t + 10 },
    path([[420, 520], [520, 470], [640, 400], [760, 340], [880, 290]], 2_500),
    path([[960, 240], [1060, 180], [1160, 130], [1240, 96], [1296, 78]], 5_000),
    path([[1304, 76], [1310, 74], [1312, 73]], 7_800),
    { type: 3, data: { source: 2, type: 2, id: button.id, x: 1312, y: 73 }, timestamp: t + 9_000 },
    { type: 3, data: { source: 1, positions: [{ x: 1312, y: 73, id: button.id, timeOffset: 0 }] }, timestamp: t + 15_000 },
  ];
}

export function mockApi(): Plugin {
  return {
    name: "csa-mock-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url?.match(/^\/((fonts|icons|products)\/[\w.-]+|player\.(js|css)|theme\.js|manifest\.webmanifest)$/)?.[1];
        if (file && existsSync(new URL(file, PUBLIC))) { res.setHeader("content-type", TYPES[file.split(".").pop()!] ?? "application/octet-stream"); return res.end(readFileSync(new URL(file, PUBLIC))); }
        if (!req.url?.startsWith("/api/")) return next();
        const url = new URL(req.url, "http://x");
        const days = Number(url.searchParams.get("days") ?? 30);
        const start = Date.parse(`${utc(Date.now())}T00:00:00Z`) - (days - 1) * DAY;
        const send = (b: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
        seed = 7;
        const p = url.pathname;
        if (p === "/api/auth/state") return send({ authenticated: true });
        if (p === "/api/auth/logout") return send({ ok: true });
        if (p === "/api/auth/enroll") return send({ url: "https://analytics.example.com/?enroll=mock_code", expiresInMinutes: 15 });
        if (p === "/api/auth/devices") return send({
          current: "os_mock1",
          passkeys: [
            { id: "pk_mac", label: "Mac · Paris", created_at: new Date(Date.now() - 14 * DAY).toISOString(), last_used_at: new Date(Date.now() - 3600_000).toISOString() },
            { id: "pk_pixel", label: "Android · Paris", created_at: new Date(Date.now() - 7 * DAY).toISOString(), last_used_at: new Date(Date.now() - DAY).toISOString() },
          ],
          sessions: [
            { id: "os_mock1", label: "Mac · Paris", created_at: new Date(Date.now() - 3 * DAY).toISOString(), last_seen_at: new Date().toISOString() },
            { id: "os_mock2", label: "Android · Paris", created_at: new Date(Date.now() - 2 * DAY).toISOString(), last_seen_at: new Date(Date.now() - 7200_000).toISOString() },
          ],
        });
        if (p.startsWith("/api/auth/sessions/") || p.startsWith("/api/auth/passkeys/")) return send({ ok: true });
        if (p === "/api/me") return send({ csrf: "x", operator: "Operator", products: PRODUCTS });
        if (p === "/api/overview") return send({ from: utc(start), days, products: PRODUCTS.map((pr, i) => { const base = [55, 18, 140, 30, 260, 22][i]!; const s = series(days, base, start); const prev = totals(series(days, base * 0.85, start - days * DAY)); return { ...pr, aiReads: Math.round([320, 90, 940, 70, 1400, 60][i]! * days / 30), totals: totals(s), previous: prev, channels: tops.channels, hours: { known: true, views: Array.from({ length: 24 }, (_, h) => Math.round(40 * Math.exp(-((h - 15) ** 2) / 18) + 4)), visits: Array.from({ length: 24 }, (_, h) => Math.round(18 * Math.exp(-((h - 15) ** 2) / 18) + 2)) }, series: s }; }) });
        if (p.startsWith("/api/product/")) { const s = series(days, 55, start); return send({ filters: url.searchParams.getAll("f"), product: "acme", host: url.searchParams.get("host") ?? "*", hosts: ["*", "acme.com", "app.acme.com", "docs.acme.com"], from: utc(start), days, totals: totals(s), previous: totals(series(days, 48, start - days * DAY)), series: s, tops,
          signupsByChannel: [{ k: "Organic Search", n: 21, paid: 4, ltv: 17400 }, { k: "AI", n: 9, paid: 3, ltv: 8700 }, { k: "Direct", n: 7, paid: 0, ltv: 0 }, { k: "Unknown", n: 3, paid: 0, ltv: 0 }],
          attribution: [{ k: "cookie", n: 18 }, { k: "hash", n: 19 }, { k: "none", n: 3 }], hours: { known: true, views: Array.from({ length: 24 }, (_, h) => Math.round(40 * Math.exp(-((h - 15) ** 2) / 18) + 4)), visits: Array.from({ length: 24 }, (_, h) => Math.round(18 * Math.exp(-((h - 15) ** 2) / 18) + 2)) }, revenue: { total: 51878, payments: 16, channels: [{ k: "Organic Search", count: 24300, users: 7 }, { k: "AI", count: 15800, users: 4 }, { k: "Direct", count: 8900, users: 3 }, { k: "Unknown", count: 2878, users: 2 }], ai_sources: [{ k: "ChatGPT", count: 12300, users: 3 }, { k: "Perplexity", count: 3500, users: 1 }], countries: [{ k: "DE", count: 21000, users: 5 }, { k: "US", count: 16000, users: 6 }, { k: "FR", count: 14878, users: 5 }], entries: [{ k: "/", count: 20000, users: 6 }, { k: "/changelog", count: 18000, users: 5 }, { k: "/pricing", count: 13878, users: 5 }], items: [{ k: "credits", count: 30000, users: 11 }, { k: "starter yearly", count: 20880, users: 1 }, { k: "refunds", count: -998, users: 1 }], kinds: [{ k: "New customer", count: 38000, users: 12 }, { k: "Repeat", count: 14876, users: 3 }, { k: "Refund", count: -998, users: 1 }], customers: [{ k: "anna@example.de", count: 20880, users: 1 }, { k: "marc@example.fr", count: 9200, users: 2 }] }, vitals: { lcp_p75: 1840, inp_p75: 120, cls_p75: 0.04 } }); }
        if (p === "/api/people") return send({ people: PEOPLE.map((x, i) => ({ ...x, country: ["DE", "FR", "IT", "DE", "FR", "GB"][i], replays: [3, 5, 0, 2, 1, 0][i] })) });
        if (p === "/api/options") return send({ pages: tops.pages.map((x) => x.k), events: tops.custom_events.map((x) => x.k).concat(["signup_completed", "checkout_completed"]), activation: "onboarding_completed" });
        if (p === "/api/funnels") { const mk = (product: string, id: string, name: string, steps: [string, string, number][], desc = "From the first step to the last, in order.") => ({ id, product, name, description: desc, steps: steps.map(([kind, value, people], i) => ({ kind, value, people, median_ms: i ? [0, 3.6e6, 9e5, 8.64e7][i] ?? 6e5 : null })), byChannel: (() => { const total = steps[0]![2], rate = steps.at(-1)![2] / total; const shares = [0.38 + rnd() * 0.2, 0.08 + rnd() * 0.1, 0.22 + rnd() * 0.12, 0.08 + rnd() * 0.08]; const lift = [0.7 + rnd() * 0.4, 1.9 + rnd() * 1, 0.8 + rnd() * 0.5, 0.5 + rnd() * 0.4]; return ["Organic Search", "AI \u00b7 ChatGPT", "Direct", "Referral"].map((k, c) => { const entered = Math.round(total * shares[c]!); return { k, entered, converted: Math.min(entered, Math.round(entered * rate * lift[c]!)) }; }); })(), entered: steps[0]![2], converted: steps.at(-1)![2] });
          return send({ days, funnels: [
            mk("fabrikam", "visit-to-paid", "Visit to paid", [["page", "*", 5240], ["event", "signup_completed", 412], ["event", "project_created", 268], ["event", "checkout_completed", 57]]),
            mk("acme", "pricing-to-activation", "Pricing to activation", [["page", "/pricing", 1830], ["event", "signup_completed", 231], ["event", "project_created", 164]]),
            mk("lumen", "docs-to-signup", "Docs to sign-up", [["page", "/docs/*", 3100], ["event", "signup_completed", 186]]),
            mk("contoso", "blog-to-trial", "Blog to trial", [["page", "/blog/*", 2650], ["event", "signup_completed", 142], ["event", "trial_started", 96]]),
          ] }); }
        if (p === "/api/ai/filter") return send({ filters: [{ dim: "country", op: "is", value: "FR" }, { dim: "page", op: "contains", value: "/blog" }] });
        if (p.startsWith("/api/activity/")) { const now = Date.now(); const mk = (m: number, event: string, path: string, extra = {}) => ({ at: now - m * 60_000, event, origin: event.startsWith("$") ? "web" : "server", host: "app.acme.com", path, channel: "AI", ai_source: "ChatGPT", referrer_host: "chatgpt.com", country: "FR", city: "Paris", device: "desktop", browser: "Chrome", os: "macOS", engaged_ms: null, props: null, ...extra }); return send({ days: 90, events: [mk(5, "$pageview", "/sites/s_1/editor"), mk(9, "report_published", "", { props: JSON.stringify({ pages: 4 }) }), mk(12, "$pageview", "/sites/s_1/pages"), mk(14, "$pageview", "/projects/new"), mk(2900, "checkout_completed", "", { props: JSON.stringify({ plan: "site" }) }), mk(2905, "$pageview", "/billing"), mk(2910, "$pageview", "/"), mk(4320, "signup_completed", ""), mk(4322, "$pageview", "/sign-up", { host: "acme.com" }), mk(4325, "$pageview", "/pricing", { host: "acme.com" }), mk(4330, "$pageview", "/blog/ab-testing-guide", { host: "acme.com" })] }); }
        if (p.startsWith("/api/person/")) { const x = PEOPLE[1]!; return send({ person: { ...x, first_touch: JSON.stringify({ channel: "AI", ai_source: "ChatGPT", referrer_host: "chatgpt.com", host: "acme.com", entry_path: "/blog/ab-testing-guide", country: "FR", at: new Date(Date.now() - 3 * DAY).toISOString() }), stripe_customer_id: "cus_R2x9" }, payments: [{ created_at: new Date().toISOString(), kind: "invoice", amount_cents: 2900, currency: "eur" }], replays: [{ id: "rs_abc", started_at: Date.now() - 7200_000, last_at: Date.now() - 6900_000, clicks: 41 }], identities: [] }); }
        if (p === "/api/replays") return send({ replays: PEOPLE.slice(0, 5).map((x, i) => ({ id: `rs_${i}abc`, product: x.product, user_id: x.user_id, email: x.email, started_at: Date.now() - i * 5 * 3600_000, last_at: Date.now() - i * 5 * 3600_000 + (240 + i * 130) * 1000, clicks: 12 + i * 9, errors: i === 2 ? 2 : 0, pages: JSON.stringify(["/", "/projects/new", "/sites/s_1/editor", "/sites/s_1/pages", "/sites/s_1/publish"].slice(0, 2 + i)), chunks: 4 })) });
        if (p.startsWith("/api/replay/")) return send({ events: replayEvents() });
        if (p === "/api/payments") return send({ payments: PEOPLE.filter((x) => x.ltv_cents).map((x, i) => ({ product: x.product, kind: "invoice", email: x.email, user_id: x.user_id, amount_cents: 2900, currency: "eur", created_at: new Date(Date.now() - i * 4 * DAY).toISOString(), livemode: 1, attribution: JSON.stringify({ channel: x.channel, ai_source: x.ai_source }) })) });
        if (p === "/api/bots") {
          const fam = { answers: 40, ai_search: 160, ai_training: 900, search: 700, preview: 120, seo: 450, other: 60 } as Record<string, number>;
          const ser = Array.from({ length: days }, (_, i) => ({ day: utc(start + i * DAY), live: i === days - 1, ...Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, Math.round((v / 30) * (0.6 + rnd()))])) }));
          const tot = Object.fromEntries(Object.keys(fam).map((k) => [k, ser.reduce((a, r: any) => a + r[k], 0)]));
          const bots = [["meta-externalagent", "ai_training", 5400], ["Googlebot", "search", 3200], ["GPTBot", "ai_training", 2100], ["bingbot", "search", 1900], ["AhrefsBot", "seo", 1700], ["OAI-SearchBot", "ai_search", 1170], ["ClaudeBot", "ai_training", 820], ["ChatGPT-User", "answers", 412], ["PerplexityBot", "ai_search", 380], ["Perplexity-User", "answers", 96], ["Claude-User", "answers", 41], ["facebookexternalhit", "preview", 300]] as const;
          return send({ sites: [...PRODUCTS, { id: "boreal", name: "Boreal", zone: "boreal.dev" }].map((x: any) => ({ id: x.id, name: x.name, zone: x.domain ?? x.zone })), site: url.searchParams.get("site") === "*" ? { id: "*", name: "All products", zone: "*", delivery: false } : { id: "lumen", name: "Lumen", zone: "lumen.club", delivery: false }, from: utc(start), days,
            totals: tot, previous: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, Math.round((v as number) * 0.8)])), series: ser,
            bots: bots.map(([bot, family, n], i) => ({ bot, family, category: "", requests: n, errors: i % 4 === 0 ? Math.round(n * 0.03) : 0, days: Math.min(days, 30 - i), pages: [{ k: "/docs/api-reference", n: 40 }, { k: "/", n: 30 }, { k: "/llms.txt", n: 12 }] })),
            pages: { answers: tops.pages.map((x) => ({ k: x.k, n: Math.round(x.views / 20) })), crawl: tops.pages.map((x) => ({ k: x.k, n: x.views * 2 })) },
            kinds: [{ k: "page", n: 9800 }, { k: "asset", n: 2100 }, { k: "feed", n: 640 }, { k: "twin", n: 220 }, { k: "llms", n: 48 }],
            statuses: [{ k: "200", n: 11200 }, { k: "301", n: 820 }, { k: "404", n: 310 }, { k: "503", n: 12 }], countries: [{ k: "US", n: 9000 }, { k: "IE", n: 1200 }], traffic: { bot: 41000, other: 59000 }, delivery: [] });
        }
        if (p === "/api/health") return send({ issues: [], runs: Array.from({ length: 8 }, (_, i) => ({ job: i % 4 === 3 ? "stripe_reconcile" : "rollup", key: utc(Date.now() - (i + 1) * DAY), status: "ok", note: `${1200 - i * 80} events`, ran_at: new Date(Date.now() - (i + 1) * DAY + 3600_000).toISOString() })) });
        res.statusCode = 404; send({ error: { code: "not_found" } });
      });
    },
  };
}
