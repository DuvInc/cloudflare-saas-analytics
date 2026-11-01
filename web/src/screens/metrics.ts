/* The figures every screen shares, defined once (SCHEMA.md says what each one counts). */
import type { Point, Totals } from "@/lib/api";
import { duration, money, num, pct } from "@/lib/fmt";
import type { Metric } from "@/components/trend";

const rate = (a: number, b: number) => (b ? (a / b) * 100 : 0);

export function metrics(t: Totals, prev: Totals | null, keys: string[]): Metric[] {
  const all: Record<string, Metric> = {
    visitors: { key: "visitors", label: "Visitors", value: num(t.visitors), now: t.visitors, before: prev?.visitors, of: (p) => p.visitors,
      hint: "Distinct visitors of each day, added up: a visitor without the cookie counts once a day." },
    visits: { key: "visits", label: "Visits", value: num(t.visits), now: t.visits, before: prev?.visits, of: (p) => p.visits },
    views: { key: "views", label: "Pageviews", value: num(t.views), now: t.views, before: prev?.views, of: (p) => p.views },
    bounce: { key: "bounce", label: "Bounce rate", value: `${pct(t.bounces, t.visits)}%`, now: rate(t.bounces, t.visits), before: prev ? rate(prev.bounces, prev.visits) : null, invert: true,
      of: (p) => Math.round(rate(p.bounces, p.visits)), format: (v) => `${v}%`, hint: "One page, under 10 s of attention, no action." },
    duration: { key: "duration", label: "Visit duration", value: duration(t.visits ? t.engaged_ms / t.visits : 0), now: t.visits ? t.engaged_ms / t.visits : 0, before: prev && prev.visits ? prev.engaged_ms / prev.visits : null,
      of: (p) => (p.visits ? Math.round(p.engaged_ms / p.visits / 1000) : 0), format: (v) => `${v} s`, hint: "Time the page was visible and active." },
    returning: { key: "returning", label: "Returning", value: num(t.returning_visitors), now: t.returning_visitors, before: prev?.returning_visitors, of: (p) => p.returning_visitors,
      hint: "Visitors seen on an earlier day. Only those who accepted the cookie." },
    signups: { key: "signups", label: "Sign-ups", tone: "signup", value: num(t.signups), now: t.signups, before: prev?.signups, of: (p) => p.signups,
      hint: `${pct(t.signups, t.visitors)}% of visitor-days.` },
    revenue: { key: "revenue", label: "Revenue", tone: "money", value: money(t.revenue_cents), now: t.revenue_cents, before: prev?.revenue_cents, of: (p) => p.revenue_cents / 100,
      format: (v) => (v >= 100 || v === 0 ? `€${Math.round(v)}` : money(v * 100)) },
  };
  return keys.map((k) => all[k]!).filter(Boolean);
}

