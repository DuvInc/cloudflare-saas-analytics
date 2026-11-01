/*
  One product: the figures and their curve (hour by hour for Today), then where people come from
  (AI assistants among the channels), what they read, where they are, what they use, what they do,
  when they come, and where the money comes from. Every breakdown row filters the screen; filters
  can also be built or described (FilterBar).
*/
import { GitFork, PlayCircle } from "lucide-react";
import { Bar, BarChart, XAxis } from "recharts";
import type { Me, Point, Top, Totals } from "@/lib/api";
import { money, num } from "@/lib/fmt";
import { href, patchParams, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { PageHeader } from "@/components/shell";
import { PeriodControl, periodFrom } from "@/components/period";
import { fillDays, TONE, TrendPanel, type Hourly } from "@/components/trend";
import { Breakdown, countryName, languageName } from "@/components/breakdown";
import { FilterBar, readFilters, withFilter, encode } from "@/components/filter-bar";
import { ProductIcon } from "@/components/icons";
import { ErrorNote } from "@/components/notes";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Hint } from "@/components/ui/help-tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { metrics } from "@/screens/metrics";

type MoneyTop = { k: string; count: number; users: number };
type ProductData = {
  product: string; host: string; hosts: string[]; from: string; days: number; totals: Totals; previous: Totals | null; series: Point[];
  tops: Record<string, Top[]>;
  signupsByChannel: { k: string; n: number; paid: number; ltv: number }[] | null;
  attribution: { k: string; n: number }[];
  vitals: { lcp_p75: number; inp_p75: number; cls_p75: number } | null;
  hours: Hourly;
  revenue: { total: number; payments: number; channels: MoneyTop[]; ai_sources: MoneyTop[]; countries: MoneyTop[]; entries: MoneyTop[]; items: MoneyTop[]; kinds: MoneyTop[]; customers: MoneyTop[] } | null;
};

const METHOD: Record<string, string> = { cookie: "cookie (exact)", hash: "same device, same day", utm_on_signup: "UTM at sign-up", none: "unknown" };
const DEVICE: Record<string, string> = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" };

function Vital({ label, value, good, hint }: { label: string; value: string; good: boolean; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-background px-4 py-2.5">
      <span className="text-xs leading-5 text-muted-foreground"><Hint content={hint}>{label}</Hint></span>
      <span className={good ? "text-lg leading-6 font-semibold tabular-nums" : "text-lg leading-6 font-semibold tabular-nums text-warning-foreground"}>{value}</span>
    </div>
  );
}

/** When people come: visits by hour of day over the period, in the browser's time zone. */
function TimeOfDay({ hours }: { hours: Hourly }) {
  const offset = -new Date().getTimezoneOffset() / 60;
  const data = Array.from({ length: 24 }, (_, local) => {
    const utc = (((local - offset) % 24) + 24) % 24;
    return { h: `${String(local).padStart(2, "0")}h`, visits: hours.visits[Math.round(utc)] ?? 0 };
  });
  const peak = data.reduce((a, b) => (b.visits > a.visits ? b : a), data[0]!);
  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-background" aria-label="Time of day">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">Time of day</h2>
        <span className="text-xs text-muted-foreground">{peak.visits ? `Busiest around ${peak.h}` : "Your time zone"}</span>
      </header>
      <div className="h-44 px-2 pt-3 pb-1">
        {hours.known ? (
          <ChartContainer config={{ visits: { label: "Visits", color: TONE.traffic } }} className="aspect-auto h-full w-full">
            <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <XAxis dataKey="h" tickLine={false} axisLine={false} interval={2} tickMargin={6} />
              <ChartTooltip isAnimationActive={false} cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as { h: string; visits: number } | undefined) : undefined;
                return p ? <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-sm"><span className="text-muted-foreground">{p.h}</span> · <span className="font-medium tabular-nums">{num(p.visits)} visits</span></div> : null;
              }} />
              <Bar dataKey="visits" fill="var(--color-visits)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ChartContainer>
        ) : <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Hours are recorded from Oct 31, 2026</p>}
      </div>
    </section>
  );
}

const asTop = (rows: MoneyTop[] | undefined) => rows?.map((r) => ({ k: r.k, count: r.count, users: r.users }));

export function ProductScreen({ me, id }: { me: Me; id: string }) {
  const { params } = useRoute();
  const days = periodFrom(params);
  const host = params.get("host") ?? "*";
  const chart = params.get("chart") ?? "visitors";
  const filters = readFilters(params);
  const active = new Set(filters);
  const setFilters = (next: string[]) => patchParams({ f: next.join("|") || null });
  const pick = (dim: string, k: string) => {
    const raw = encode(dim, "is", k);
    setFilters(active.has(raw) ? filters.filter((f) => f !== raw) : withFilter(filters, raw));
  };
  const fq = [...filters].sort().map((f) => `&f=${encodeURIComponent(f)}`).join("");
  const { data, error, current, reload } = useData<ProductData>(`/api/product/${id}?days=${days}&host=${encodeURIComponent(host)}${fq}`);
  const product = me.products.find((p) => p.id === id);
  const t = data?.tops;
  const ai = t?.channels?.find((c) => c.k === "AI")?.visits ?? 0;
  const hosts = (data?.hosts ?? []).filter((h) => h !== "*").sort();
  const keys = (rows?: Top[]) => rows?.map((r) => r.k) ?? [];
  const options: Record<string, string[]> = {
    channel: keys(t?.channels), referrer: keys(t?.referrers), ai: keys(t?.ai_sources), utm_source: keys(t?.utm_sources), utm_campaign: keys(t?.utm_campaigns),
    entry: keys(t?.entries), page: keys(t?.pages), country: keys(t?.countries), city: keys(t?.cities), device: keys(t?.devices), browser: keys(t?.browsers),
    os: keys(t?.os), lang: keys(t?.langs), event: keys(t?.custom_events),
  };
  const r = data?.revenue;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={<span className="flex items-center gap-3"><ProductIcon id={id} name={product?.name ?? id} className="size-9" />{product?.name ?? id}</span>} meta={product?.domain}>
        <Button variant="outline" render={<a href={href("/funnels", { product: id, days: Math.min(days, 90) })} />}><GitFork data-icon="inline-start" />Funnels</Button>
        <Button variant="outline" render={<a href={href("/replays", { product: id })} />}><PlayCircle data-icon="inline-start" />Replays</Button>
        {hosts.length > 1 && (
          <Select value={host} onValueChange={(v) => patchParams({ host: v === "*" ? null : String(v) })}>
            <SelectTrigger aria-label="Site" className="min-w-40"><SelectValue>{(v: string) => (v === "*" ? "All sites" : v)}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="*">All sites</SelectItem>
              {hosts.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <PeriodControl days={days} onChange={(d) => patchParams({ days: d })} />
      </PageHeader>
      <ErrorNote error={error} onRetry={reload} />
      <FilterBar product={id} filters={filters} options={options} onChange={setFilters} className="-mt-2" />

      <TrendPanel
        metrics={data ? metrics(data.totals, data.previous, ["visitors", "visits", "views", "signups", "bounce", "duration", "returning", "revenue"]) : null}
        selected={chart}
        onSelect={(k) => patchParams({ chart: k === "visitors" ? null : k })}
        series={data ? fillDays(data.series, data.from, data.days) : []}
        hourly={days === 1 ? data?.hours : null}
        current={current}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown active={active} onPick={pick} title="Sources" dimensions={[
          { key: "channels", label: "Channels", dim: "channel", rows: t?.channels, by: "visits", column: "Visits", second: { by: "visitors", column: "Visitors" } },
          { key: "referrers", label: "Referrers", dim: "referrer", rows: t?.referrers, by: "visits", column: "Visits" },
          { key: "ai", label: `AI${ai ? ` · ${num(ai)}` : ""}`, dim: "ai", tone: "ai", rows: t?.ai_sources, by: "visits", column: "Visits" },
          { key: "utm", label: "UTM", dim: "utm_source", rows: t?.utm_sources, by: "visits", column: "Visits" },
          { key: "campaigns", label: "Campaigns", dim: "utm_campaign", rows: t?.utm_campaigns, by: "visits", column: "Visits" },
        ]} />
        <Breakdown active={active} onPick={pick} title="Pages" dimensions={[
          { key: "pages", label: "Pages", dim: "page", rows: t?.pages, by: "views", column: "Views", second: { by: "visitors", column: "Visitors" } },
          { key: "entries", label: "Entry pages", dim: "entry", rows: t?.entries, by: "visits", column: "Visits" },
        ]} />
        <Breakdown active={active} onPick={pick} title="Locations" dimensions={[
          { key: "countries", label: "Countries", dim: "country", rows: t?.countries, by: "visitors", column: "Visitors", name: countryName },
          { key: "cities", label: "Cities", dim: "city", rows: t?.cities, by: "visitors", column: "Visitors" },
          { key: "langs", label: "Languages", dim: "lang", rows: t?.langs, by: "visitors", column: "Visitors", name: languageName },
        ]} />
        <Breakdown active={active} onPick={pick} title="Devices" dimensions={[
          { key: "devices", label: "Devices", dim: "device", rows: t?.devices, by: "visitors", column: "Visitors", name: (k) => DEVICE[k] ?? k },
          { key: "browsers", label: "Browsers", dim: "browser", rows: t?.browsers, by: "visitors", column: "Visitors" },
          { key: "os", label: "OS", dim: "os", rows: t?.os, by: "visitors", column: "Visitors" },
        ]} />
        <Breakdown active={active} onPick={pick} title="Events" dimensions={[
          { key: "events", label: "Product events", dim: "event", tone: "signup", rows: t?.custom_events, by: "count", column: "Times", second: { by: "users", column: "People" } },
        ]} />
        {data ? <TimeOfDay hours={data.hours} /> : <div className="h-60 animate-pulse rounded-xl border bg-muted/30" />}
      </div>

      {r && r.payments > 0 && (
        <section className="flex flex-col gap-3" aria-labelledby="revenue">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="revenue" className="text-base font-semibold tracking-tight">Revenue</h2>
            <span className="text-sm text-muted-foreground"><span className="font-semibold" style={{ color: TONE.money }}>{money(r.total)}</span> from {num(r.payments)} payments</span>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Breakdown title="Where the money comes from" dimensions={[
              { key: "channels", label: "Channels", tone: "money", rows: asTop(r.channels), by: "count", column: "Revenue" },
              { key: "ai", label: "AI", tone: "money", rows: asTop(r.ai_sources), by: "count", column: "Revenue" },
              { key: "entries", label: "Entry pages", tone: "money", rows: asTop(r.entries), by: "count", column: "Revenue" },
              { key: "countries", label: "Countries", tone: "money", rows: asTop(r.countries), by: "count", column: "Revenue", name: countryName },
            ]} format={(v) => money(v)} />
            <Breakdown title="What was bought" dimensions={[
              { key: "items", label: "Items", tone: "money", rows: asTop(r.items), by: "count", column: "Revenue" },
              { key: "kinds", label: "New or repeat", tone: "money", rows: asTop(r.kinds), by: "count", column: "Revenue" },
              { key: "customers", label: "Top customers", tone: "money", rows: asTop(r.customers), by: "count", column: "Revenue" },
            ]} format={(v) => money(v)} />
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="@container flex min-w-0 flex-col rounded-xl border bg-background" aria-labelledby="signups-by-channel">
          <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
            <h2 id="signups-by-channel" className="text-sm font-medium">Sign-ups by origin</h2>
            {data && data.attribution.length > 0 && (
              <span className="text-xs text-muted-foreground"><Hint content={data.attribution.map((a) => `${METHOD[a.k] ?? a.k}: ${a.n}`).join(" · ")}>Method</Hint></span>
            )}
          </header>
          {data?.signupsByChannel?.length ? (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Channel</TableHead>
                  <TableHead className="w-20 text-right">Sign-ups</TableHead>
                  <TableHead className="hidden w-20 text-right @md:table-cell">Paying</TableHead>
                  <TableHead className="w-24 pr-4 text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.signupsByChannel.map((x) => (
                  <TableRow key={x.k}>
                    <TableCell className="truncate pl-4">{x.k === "Inconnu" ? "Unknown" : x.k}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(x.n)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums @md:table-cell">{num(x.paid)}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{money(x.ltv)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="flex min-h-40 flex-1 items-center justify-center text-sm text-muted-foreground">{data ? (data.signupsByChannel === null ? "This filter does not apply to sign-ups" : "No sign-up in this period") : ""}</p>
          )}
        </section>
        {data && (
          <section aria-label="Performance" className="@container h-fit overflow-hidden rounded-xl border">
            <div className="grid grid-cols-2 gap-px bg-border">
              {data.vitals ? (
                <>
                  <Vital label="LCP" value={`${num(data.vitals.lcp_p75)} ms`} good={data.vitals.lcp_p75 <= 2500} hint="Main content shown, p75 of the worst day. Good under 2.5 s." />
                  <Vital label="INP" value={`${num(data.vitals.inp_p75)} ms`} good={data.vitals.inp_p75 <= 200} hint="Response to clicks, p75 of the worst day. Good under 200 ms." />
                  <Vital label="CLS" value={(data.vitals.cls_p75 ?? 0).toFixed(3)} good={(data.vitals.cls_p75 ?? 0) <= 0.1} hint="Layout shifts. Good under 0.1." />
                </>
              ) : <div className="col-span-1 bg-background px-4 py-2.5 text-sm text-muted-foreground">No Web Vitals yet</div>}
              <Vital label="Bots excluded" value={num(data.totals.bot_views)} good hint="Pageviews from bots that run JavaScript, removed from every figure." />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
