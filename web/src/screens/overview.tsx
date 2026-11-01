/*
  Every product at a glance: the sum of all of them as one strip and curve, then one card per
  product, two columns, each with its logo, visitors and their change, a few figures and the
  period's curve. A card opens the product.
*/
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { Me, Point, Top, Totals } from "@/lib/api";
import { compact, money, num } from "@/lib/fmt";
import { href, navigate, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { PageHeader } from "@/components/shell";
import { PeriodControl, PERIODS, periodFrom } from "@/components/period";
import { ChangeBadge, fillDays, MiniBars, Spark, TONE, TrendPanel, type Hourly } from "@/components/trend";
import { ProductIcon } from "@/components/icons";
import { ErrorNote } from "@/components/notes";
import { metrics } from "@/screens/metrics";
import { NUMS } from "@/lib/api";

type P = { id: string; name: string; domain: string; totals: Totals; previous: Totals | null; channels: Top[]; hours: Hourly; series: Point[]; aiReads?: number };
type Overview = { from: string; days: number; products: P[] };

const sum = (list: (Totals | null)[]) => (list.some(Boolean) ? (Object.fromEntries(NUMS.map((k) => [k, list.reduce((s, t) => s + (t?.[k] ?? 0), 0)])) as Totals) : null);

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
        {color && <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: color }} />}{label}
      </span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function ProductCard({ p, from, days }: { p: P; from: string; days: number }) {
  const series = fillDays(p.series, from, days);
  const t = p.totals;
  return (
    <a
      href={href(`/p/${p.id}`, { days })}
      className="group flex min-w-0 flex-col gap-4 rounded-xl border bg-background p-5 outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-center gap-3">
        <ProductIcon id={p.id} name={p.name} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold tracking-tight">{p.name}</span>
          <span className="truncate text-xs text-muted-foreground">{p.domain}</span>
        </div>
        {t.revenue_cents > 0 && (
          <span className="rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums" style={{ background: "color-mix(in oklch, var(--viz-money) 16%, transparent)", color: "color-mix(in oklch, var(--viz-money) 70%, var(--foreground))" }}>
            {money(t.revenue_cents)}
          </span>
        )}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Visitors</span>
          <span className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">{compact(t.visitors)}</span>
            <ChangeBadge now={t.visitors} before={p.previous?.visitors} />
          </span>
        </div>
        <div className="grid grid-cols-3 gap-4 sm:text-right">
          <Figure label="Visits" value={num(t.visits)} />
          <Figure label="Sign-ups" value={num(t.signups)} color={TONE.signup} />
          <Figure label="AI reads" value={num(p.aiReads ?? 0)} color={TONE.ai} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Spark series={days === 1 && p.hours?.known ? p.hours.visits.slice(0, new Date().getUTCHours() + 1) : series.map((x) => x.visitors)} color={TONE.traffic} width={400} height={56} className="h-14 w-full" />
        {days > 1 && t.revenue_cents > 0 && <MiniBars series={series.map((x) => x.revenue_cents)} color={TONE.money} width={400} height={20} className="h-5 w-full" />}
      </div>
    </a>
  );
}

export function OverviewScreen({ me }: { me: Me }) {
  const { params } = useRoute();
  const days = periodFrom(params);
  const [chart, setChart] = useState("visitors");
  const { data, error, current, reload } = useData<Overview>(`/api/overview?days=${days}`);
  const label = PERIODS.find((p) => p.days === days)?.label.toLowerCase();

  let strip = null;
  if (data) {
    const totals = sum(data.products.map((p) => p.totals))!;
    const previous = sum(data.products.map((p) => p.previous));
    const filled = data.products.map((p) => fillDays(p.series, data.from, data.days));
    const series = filled[0]?.map((d, i) => ({ ...d, ...Object.fromEntries(NUMS.map((k) => [k, filled.reduce((s, f) => s + (f[i]![k] ?? 0), 0)])), live: filled.some((f) => f[i]!.live) })) ?? [];
    const hours: Hourly = { known: data.products.some((p) => p.hours?.known), views: Array.from({ length: 24 }, (_, i) => data.products.reduce((s, p) => s + (p.hours?.views[i] ?? 0), 0)), visits: Array.from({ length: 24 }, (_, i) => data.products.reduce((s, p) => s + (p.hours?.visits[i] ?? 0), 0)) };
    strip = <TrendPanel metrics={metrics(totals, previous, ["visitors", "visits", "signups", "revenue"])} selected={chart} onSelect={setChart} series={series} hourly={days === 1 ? hours : null} current={current} height="h-56" />;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Overview" meta={data ? `${data.products.length} products, ${label}` : undefined}>
        <PeriodControl days={days} onChange={(d) => navigate("/", { days: d }, { replace: true })} />
      </PageHeader>
      <ErrorNote error={error} onRetry={reload} />
      {strip ?? (!error && <TrendPanel metrics={null} series={[]} height="h-56" placeholders={5} />)}
      <section className="flex flex-col gap-3" aria-label="Products">
        <h2 className="text-base font-semibold tracking-tight">Products</h2>
        <div className={`grid gap-4 transition-opacity md:grid-cols-2 ${current ? "" : "opacity-60"}`}>
          {data
            ? [...data.products].sort((a, b) => b.totals.visitors - a.totals.visitors).map((p) => <ProductCard key={p.id} p={p} from={data.from} days={data.days} />)
            : !error && me.products.map((p) => (
              <div key={p.id} className="flex h-52 flex-col gap-4 rounded-xl border p-5">
                <div className="flex items-center gap-3"><ProductIcon id={p.id} name={p.name} /><span className="font-semibold">{p.name}</span></div>
                <span className="h-8 w-24 animate-pulse rounded bg-muted" />
                <span className="h-16 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
