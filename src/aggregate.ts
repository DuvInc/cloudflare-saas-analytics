/*
  One day of raw events -> visits and the day's numbers. Pure: tested in test/aggregate.test.ts.

  Identity of a hit, strongest first: user_id, then anon_id (cookie), then day_hash, else the hit
  stands alone. A cookie or hash that a user_id also carries the same day is folded into that user,
  so signing in mid-visit does not split the visit.
  Visit: hits of one identity with no gap above 30 minutes. Its source is its first page view.
  Bounce: one page view and under 10 s engaged.
*/
export type Raw = Record<string, any>;
export type Top = { k: string; views?: number; visits?: number; visitors?: number; count?: number; users?: number };

const GAP = 30 * 60_000;
const BOUNCE_MS = 10_000;
const TOPN = 100;

export function identOf(e: Raw, alias: Map<string, string>): string {
  if (e.user_id) return `u:${e.user_id}`;
  const a = e.anon_id ? alias.get(`a:${e.anon_id}`) ?? `a:${e.anon_id}` : null;
  if (a) return a;
  if (e.day_hash) return alias.get(`h:${e.day_hash}`) ?? `h:${e.day_hash}`;
  return `x:${e.received_at}:${Math.random()}`;
}

/** Sorts in place, assigns visit_id to every event, returns visit summaries. */
export function sessionize(events: Raw[]) {
  events.sort((a, b) => (a.received_at - b.received_at) || (a.ts - b.ts));
  const alias = new Map<string, string>();
  for (const e of events) {
    if (!e.user_id) continue;
    if (e.anon_id && !alias.has(`a:${e.anon_id}`)) alias.set(`a:${e.anon_id}`, `u:${e.user_id}`);
    if (e.day_hash && !alias.has(`h:${e.day_hash}`)) alias.set(`h:${e.day_hash}`, `u:${e.user_id}`);
  }
  const open = new Map<string, Visit>();
  const visits: Visit[] = [];
  for (const e of events) {
    if (e.is_bot) continue;
    const ident = identOf(e, alias);
    let v = open.get(ident);
    if (!v || e.received_at - v.last > GAP) {
      v = { id: `v${visits.length.toString(36)}_${(e.received_at as number).toString(36)}`, ident, product: e.product, start: e.received_at, last: e.received_at, views: 0, engaged: 0, entry: null, events: 0, user: null, anon: null };
      visits.push(v);
      open.set(ident, v);
    }
    v.last = e.received_at;
    e.visit_id = v.id;
    if (e.user_id) v.user = e.user_id;
    if (e.anon_id) v.anon = e.anon_id;
    if (e.event === "$pageview") {
      v.views++;
      if (!v.entry) v.entry = e;
    } else if (e.event === "$pageleave") v.engaged += e.engaged_ms ?? 0;
    else if (!String(e.event).startsWith("$")) v.events++;
  }
  return visits;
}

export type Visit = { id: string; ident: string; product: string; start: number; last: number; views: number; engaged: number; entry: Raw | null; events: number; user: string | null; anon: string | null };

class Counter {
  m = new Map<string, { views: number; visits: number; vis: Set<string> }>();
  add(k: string, ident: string, views = 1, visits = 0) {
    if (!k) return;
    let c = this.m.get(k);
    if (!c) { c = { views: 0, visits: 0, vis: new Set() }; this.m.set(k, c); }
    c.views += views; c.visits += visits; c.vis.add(ident);
  }
  top(by: "views" | "visits" | "visitors"): Top[] {
    return [...this.m.entries()]
      .map(([k, c]) => ({ k, views: c.views, visits: c.visits, visitors: c.vis.size }))
      .sort((a, b) => (b[by] - a[by]) || a.k.localeCompare(b.k)).slice(0, TOPN);
  }
}

const p75 = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.75))]!;
};

export type DayRow = {
  product: string; host: string; day: string;
  views: number; visitors: number; visits: number; bounces: number; engaged_ms: number; returning: number;
  signups: number; events: number; bot_views: number;
  pages: Top[]; entries: Top[]; referrers: Top[]; channels: Top[]; ai_sources: Top[]; utm_sources: Top[]; utm_campaigns: Top[];
  countries: Top[]; cities: Top[]; devices: Top[]; browsers: Top[]; os: Top[]; langs: Top[]; custom_events: Top[];
  vitals: { lcp_p75: number | null; inp_p75: number | null; cls_p75: number | null; n: number; n_lcp?: number; n_inp?: number; n_cls?: number };
  /** UTC hour by hour: page views, and visits by the hour they started. */
  hourly: { views: number[]; visits: number[] };
};

/**
 * @param events the day's events of every product (already sessionized)
 * @param visits from sessionize
 * @param returningAnon anon ids first seen before this day
 */
export function aggregate(day: string, events: Raw[], visits: Visit[], returningAnon: Set<string>): DayRow[] {
  const groups = new Map<string, { events: Raw[]; visits: Visit[] }>();
  const key = (p: string, h: string) => `${p}\u0000${h}`;
  const g = (p: string, h: string) => {
    let x = groups.get(key(p, h));
    if (!x) { x = { events: [], visits: [] }; groups.set(key(p, h), x); }
    return x;
  };
  for (const e of events) {
    g(e.product, "*").events.push(e);
    if (e.host) g(e.product, e.host).events.push(e);
  }
  for (const v of visits) {
    g(v.product, "*").visits.push(v);
    const h = v.entry?.host;
    if (h) g(v.product, h).visits.push(v);
  }
  const rows: DayRow[] = [];
  for (const [k, { events: evs, visits: vs }] of groups) {
    const [product, host] = k.split("\u0000") as [string, string];
    const vById = new Map(vs.map((v) => [v.id, v]));
    const pages = new Counter(), countries = new Counter(), cities = new Counter(), devices = new Counter(), browsers = new Counter(), os = new Counter(), langs = new Counter();
    const entries = new Counter(), referrers = new Counter(), channels = new Counter(), ai = new Counter(), utmS = new Counter(), utmC = new Counter(), custom = new Counter();
    const idents = new Set<string>();
    const returningIdents = new Set<string>();
    let views = 0, bot_views = 0, signups = 0, nEvents = 0;
    const hViews = new Array<number>(24).fill(0), hVisits = new Array<number>(24).fill(0);
    const lcp: number[] = [], inp: number[] = [], cls: number[] = [];
    for (const e of evs) {
      if (e.is_bot) { if (e.event === "$pageview") bot_views++; continue; }
      const v = e.visit_id ? vById.get(e.visit_id) : undefined;
      const ident = v?.ident ?? `x:${e.received_at}`;
      if (e.event === "$pageview") {
        views++;
        hViews[new Date(e.received_at).getUTCHours()]!++;
        /* A hit with no identity at all (Do Not Track / GPC, no cookie, signed out) is a view,
           never a visitor: counting it would make every such page view a new person. */
        if (!ident.startsWith("x:")) idents.add(ident);
        if (e.anon_id && returningAnon.has(e.anon_id)) returningIdents.add(ident);
        pages.add(e.path || "/", ident);
        countries.add(e.country || "??", ident);
        if (e.city) cities.add(`${e.city}, ${e.country}`, ident);
        devices.add(e.device || "?", ident);
        browsers.add(e.browser || "?", ident);
        os.add(e.os || "?", ident);
        langs.add((e.lang || e.langs?.split(",")[0] || "?").slice(0, 2), ident);
      } else if (e.event === "$pageleave") {
        if (typeof e.lcp_ms === "number") lcp.push(e.lcp_ms);
        if (typeof e.inp_ms === "number") inp.push(e.inp_ms);
        if (typeof e.cls === "number") cls.push(e.cls);
      } else if (!String(e.event).startsWith("$")) {
        nEvents++;
        if (e.event === "signup_completed") signups++;
        custom.add(e.event, e.user_id ? `u:${e.user_id}` : ident);
      }
    }
    let bounces = 0, engaged = 0;
    for (const v of vs) {
      if (!v.views) continue;
      engaged += v.engaged;
      if (v.views === 1 && v.engaged < BOUNCE_MS && v.events === 0) bounces++;
      const en = v.entry!;
      hVisits[new Date(v.start).getUTCHours()]!++;
      entries.add(en.path || "/", v.ident, 0, 1);
      channels.add(en.channel || "Direct", v.ident, 0, 1);
      if (en.referrer_host) referrers.add(en.referrer_host, v.ident, 0, 1);
      if (en.ai_source) ai.add(en.ai_source, v.ident, 0, 1);
      if (en.utm_source) utmS.add(en.utm_source, v.ident, 0, 1);
      if (en.utm_campaign) utmC.add(en.utm_campaign, v.ident, 0, 1);
    }
    const customTop = [...custom.m.entries()].map(([k, c]) => ({ k, count: c.views, users: c.vis.size })).sort((a, b) => b.count - a.count).slice(0, TOPN);
    rows.push({
      product, host, day,
      views, visitors: idents.size, visits: vs.filter((v) => v.views > 0).length, bounces, engaged_ms: engaged,
      returning: returningIdents.size, signups, events: nEvents, bot_views,
      pages: pages.top("views"), entries: entries.top("visits"), referrers: referrers.top("visits"), channels: channels.top("visits"),
      ai_sources: ai.top("visits"), utm_sources: utmS.top("visits"), utm_campaigns: utmC.top("visits"),
      countries: countries.top("visitors"), cities: cities.top("visitors").slice(0, 50), devices: devices.top("visitors"),
      browsers: browsers.top("visitors"), os: os.top("visitors"), langs: langs.top("visitors"), custom_events: customTop,
      vitals: { lcp_p75: p75(lcp), inp_p75: p75(inp), cls_p75: p75(cls), n: lcp.length, n_lcp: lcp.length, n_inp: inp.length, n_cls: cls.length },
      hourly: { views: hViews, visits: hVisits },
    });
  }
  return rows;
}
