/*
  The figures of a screen and the curve of the one chosen, in one bordered panel. Each figure has
  its colour (traffic blue, money coral, sign-ups green, AI violet), a mini curve of the period and
  its change against the period before; the chosen one is underlined in its colour. The big chart
  draws the chosen figure, revenue as coral bars behind it, and today
  (still counting) as a dashed end.
*/
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Area, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import type { Point } from "@/lib/api";
import { change, compact, day, dayFull, money } from "@/lib/fmt";
import { sparklinePath } from "@/lib/sparkline";
import { cn } from "@/lib/utils";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Hint } from "@/components/ui/help-tooltip";

export type Tone = "traffic" | "money" | "signup" | "ai";
export const TONE: Record<Tone, string> = { traffic: "var(--viz-traffic)", money: "var(--viz-money)", signup: "var(--viz-signup)", ai: "var(--viz-ai)" };

export type Metric = {
  key: string;
  label: string;
  value: string;
  now?: number;
  before?: number | null;
  /** A rise is bad (bounce rate). */
  invert?: boolean;
  hint?: string;
  tone?: Tone;
  /** The day's value; absent = not chartable. */
  of?: (p: Point) => number | null;
  format?: (v: number) => string;
};

export function fillDays(series: Point[], from: string, days: number): Point[] {
  const by = new Map(series.map((p) => [p.day, p]));
  const out: Point[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86400_000).toISOString().slice(0, 10);
    out.push(by.get(d) ?? ({ day: d, live: false, views: 0, visitors: 0, visits: 0, bounces: 0, engaged_ms: 0, returning_visitors: 0, signups: 0, events: 0, bot_views: 0, revenue_cents: 0 } as Point));
  }
  return out;
}

export function ChangeBadge({ now, before, invert, className }: { now?: number; before?: number | null; invert?: boolean; className?: string }) {
  const c = now === undefined ? null : change(now, before);
  if (c === null) return null;
  const good = invert ? c < 0 : c > 0;
  const Icon = c >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium tabular-nums", c === 0 ? "text-muted-foreground" : good ? "text-up" : "text-down", className)}>
      {c !== 0 && <Icon className="size-3.5" />}{Math.abs(c)}%
    </span>
  );
}

/** A small curve of a series, in a colour: the stat strip's sparkline, coloured. */
export function Spark({ series, color, className, width = 72, height = 28 }: { series: (number | null)[]; color: string; className?: string; width?: number; height?: number }) {
  const shape = sparklinePath(series, width, height);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("shrink-0 overflow-visible", className)} style={{ color }}>
      {shape && (
        <g className={shape.flat ? "opacity-40" : undefined}>
          {shape.area && <path d={shape.area} fill="currentColor" fillOpacity={0.12} stroke="none" />}
          <path d={shape.d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </svg>
  );
}

/** Small bars of a series (money is never a curve). */
export function MiniBars({ series, color, className, width = 72, height = 28 }: { series: (number | null)[]; color: string; className?: string; width?: number; height?: number }) {
  const vals = series.map((v) => v ?? 0);
  const max = Math.max(...vals, 0);
  const n = Math.max(vals.length, 1);
  const w = width / n;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("shrink-0", className)}>
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={color} strokeOpacity={0.25} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {max > 0 && vals.map((v, i) => v > 0 && (
        <rect key={i} x={i * w + w * 0.15} width={Math.max(w * 0.7, 1)} y={height - Math.max((v / max) * height, 2)} height={Math.max((v / max) * height, 2)} rx={Math.min(w * 0.3, 2)} fill={color} />
      ))}
    </svg>
  );
}

function Segment({ m, series, selected, onSelect }: { m: Metric; series: Point[]; selected: boolean; onSelect?: () => void }) {
  const color = TONE[m.tone ?? "traffic"];
  const body = (
    <>
      <span className="flex items-center gap-1.5 truncate text-xs leading-5 text-muted-foreground">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        {m.hint ? <Hint content={m.hint}>{m.label}</Hint> : m.label}
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="flex flex-col">
          <span className="text-xl leading-7 font-semibold tracking-tight tabular-nums">{m.value}</span>
          <ChangeBadge now={m.now} before={m.before} invert={m.invert} className="h-4" />
        </span>
        {m.of && series.length > 1 && (m.tone === "money"
          ? <MiniBars series={series.map((p) => m.of!(p))} color={color} className="mb-1 h-7 w-16 @6xl:w-20" />
          : <Spark series={series.map((p) => m.of!(p))} color={color} className="mb-1 h-7 w-16 @6xl:w-20" />)}
      </span>
    </>
  );
  const base = "relative flex min-w-0 flex-col gap-1 bg-background px-4 pt-3 pb-3 text-left";
  if (!onSelect) return <div className={base}>{body}</div>;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(base, "outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50")}
    >
      {body}
      <span aria-hidden="true" className={cn("absolute inset-x-0 bottom-0 h-0.5 transition-opacity", selected ? "opacity-100" : "opacity-0")} style={{ background: color }} />
    </button>
  );
}

const COLS: Record<number, string> = {
  3: "grid-cols-2 @2xl:grid-cols-3",
  4: "grid-cols-2 @2xl:grid-cols-4",
  5: "grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-5",
  6: "grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-6",
  8: "grid-cols-2 @2xl:grid-cols-4",
};

type Row = { day: string; label?: string; live: boolean; v: number | null; tail: number | null; money: number };

/** Today hour by hour, in the browser's time zone: the UTC buckets shifted. Traffic only. */
export type Hourly = { views: number[]; visits: number[]; known: boolean };
function hourRows(h: Hourly, key: string): Row[] {
  const offset = -new Date().getTimezoneOffset() / 60;
  const now = new Date().getHours();
  return Array.from({ length: 24 }, (_, local) => {
    const utc = (((local - offset) % 24) + 24) % 24;
    const v = (key === "views" ? h.views : h.visits)[Math.round(utc)] ?? 0;
    return { day: "", label: `${String(local).padStart(2, "0")}:00`, live: local === now, v: local <= now ? v : null, tail: null, money: 0 };
  });
}

export function TrendPanel({
  metrics, selected, onSelect, series, hourly, current = true, height = "h-64", placeholders = 4, className,
}: {
  metrics: Metric[] | null;
  selected?: string;
  onSelect?: (key: string) => void;
  series: Point[];
  /** Today: draw the chosen traffic figure hour by hour (views, or visits for the others). */
  hourly?: Hourly | null;
  current?: boolean;
  height?: string;
  placeholders?: number;
  className?: string;
}) {
  const metric = metrics?.find((m) => m.key === selected && m.of) ?? metrics?.find((m) => m.of);
  const color = TONE[metric?.tone ?? "traffic"];
  const liveAt = series.findIndex((p) => p.live);
  const hours = !!hourly?.known && (metric?.tone ?? "traffic") === "traffic";
  const data: Row[] = hours ? hourRows(hourly!, metric?.key === "views" ? "views" : "visits") : metric?.of ? series.map((p, i) => {
    const v = metric.of!(p);
    return { day: p.day, live: p.live, v: liveAt >= 0 && i >= liveAt ? null : v, tail: liveAt >= 0 && i >= liveAt - 1 ? v : null, money: (p.revenue_cents ?? 0) / 100 };
  }) : [];
  if (!hours && liveAt === 0 && data[0]) data[0].v = data[0].tail;
  /* Money is always bars: the chosen figure when it is revenue, else behind the traffic curve. */
  const moneyChosen = metric?.key === "revenue";
  const showMoney = !hours && !moneyChosen && data.some((d) => d.money > 0);
  const config = { v: { label: metric?.label ?? "", color }, money: { label: "Revenus", color: TONE.money } } satisfies ChartConfig;
  const n = metrics?.length ?? placeholders;
  const fmt = (v: number) => (metric?.format ? metric.format(v) : compact(v));

  return (
    <section className={cn("@container overflow-hidden rounded-xl border bg-background transition-opacity", !current && "opacity-60", className)} aria-busy={!metrics || !current}>
      <div className={cn("grid gap-px border-b bg-border", COLS[n] ?? COLS[4], "[&>*:last-child:nth-child(odd)]:col-span-2 @2xl:[&>*:last-child:nth-child(odd)]:col-span-1")}>
        {metrics
          ? metrics.map((m) => <Segment key={m.key} m={m} series={series} selected={m.key === metric?.key} onSelect={onSelect && m.of ? () => onSelect(m.key) : undefined} />)
          : Array.from({ length: n }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 bg-background px-4 py-3">
              <span className="h-4 w-16 animate-pulse rounded-sm bg-muted" />
              <span className="h-7 w-20 animate-pulse rounded-sm bg-muted" />
            </div>
          ))}
      </div>
      <div className={cn("px-2 pt-5 pb-2", height)}>
        {metrics && data.length > 0 ? (
          <ChartContainer config={config} className="aspect-auto h-full w-full">
            <ComposedChart data={data} margin={{ top: 6, right: showMoney ? 0 : 12, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 4" />
              <XAxis dataKey={hours ? "label" : "day"} tickLine={false} axisLine={false} tickMargin={10} minTickGap={hours ? 24 : 40} interval="preserveStartEnd" tickFormatter={hours ? undefined : day} />
              <YAxis yAxisId="v" width={44} tickLine={false} axisLine={false} tickMargin={4} allowDecimals={false} tickFormatter={fmt} />
              {showMoney && <YAxis yAxisId="money" orientation="right" width={52} tickLine={false} axisLine={false} tickMargin={4} tickFormatter={(v) => `€${compact(v)}`} />}
              <ChartTooltip
                isAnimationActive={false}
                cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const p = active ? (payload?.[0]?.payload as Row | undefined) : undefined;
                  if (!p) return null;
                  const v = p.v ?? p.tail ?? 0;
                  return (
                    <div className="grid min-w-44 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs shadow-sm">
                      <span className="text-muted-foreground first-letter:uppercase">{hours ? `Today, ${p.label}` : dayFull(p.day)}{p.live ? " · so far" : ""}</span>
                      <Line2 color={color} label={metric?.label ?? ""} value={fmt(v)} />
                      {showMoney && p.money > 0 && <Line2 color={TONE.money} label="Revenue" value={money(p.money * 100)} />}
                    </div>
                  );
                }}
              />
              {showMoney && <Bar yAxisId="money" dataKey="money" fill="var(--color-money)" fillOpacity={0.55} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />}
              {moneyChosen && <Bar yAxisId="v" dataKey="money" fill="var(--color-money)" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />}
              {!moneyChosen && <Area yAxisId="v" dataKey="v" type="monotone" stroke="var(--color-v)" strokeWidth={2} fill="var(--color-v)" fillOpacity={0.1} isAnimationActive={false} connectNulls={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)", fill: "var(--color-v)" }}
                dot={false} />}
              {!moneyChosen && <Line yAxisId="v" dataKey="tail" type="monotone" stroke="var(--color-v)" strokeWidth={2} strokeDasharray="4 4" dot={false} activeDot={false} isAnimationActive={false} connectNulls={false} />}
            </ComposedChart>
          </ChartContainer>
        ) : (
          <div className="h-full animate-pulse rounded-lg bg-muted/50" />
        )}
      </div>
    </section>
  );
}

function Line2({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: color }} />{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  );
}
