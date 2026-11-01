/*
  AI & bots: what the machines did on a site, from Cloudflare's logs (src/bots.ts). Humans who
  arrive from an assistant are not here: they are the "AI" channel of the product screen.

  The families, most useful first: an assistant read a page to answer someone (ChatGPT-User,
  Claude-User...), an assistant's search index (OAI-SearchBot, PerplexityBot...), model training
  (GPTBot, ClaudeBot, meta-externalagent...), then search engines, link previews, SEO tools.
  A family card or a bot row filters the screen (family, bot in the address).
*/
import { X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { Me } from "@/lib/api";
import { compact, day, dayFull, num } from "@/lib/fmt";
import { patchParams, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { PeriodControl, periodFrom } from "@/components/period";
import { ErrorNote } from "@/components/notes";
import { ProductIcon, ValueIcon } from "@/components/icons";
import { Breakdown } from "@/components/breakdown";
import { ChangeBadge, Spark } from "@/components/trend";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Hint } from "@/components/ui/help-tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Family = "answers" | "ai_search" | "ai_training" | "search" | "preview" | "seo" | "other";
type Data = {
  sites: { id: string; name: string; zone: string }[];
  site: { id: string; name: string; zone: string; delivery: boolean } | null;
  from: string; days: number;
  totals: Record<Family, number>; previous: Record<Family, number> | null;
  series: ({ day: string; live: boolean } & Partial<Record<Family, number>>)[];
  bots: { bot: string; family: Family; category: string; requests: number; errors: number; days: number; pages: { k: string; n: number }[] }[];
  pages: { answers: { k: string; n: number }[]; crawl: { k: string; n: number }[] };
  kinds: { k: string; n: number }[]; statuses: { k: string; n: number }[]; countries: { k: string; n: number }[];
  traffic: { bot: number; other: number };
  delivery: { format: string; tool: string; calls: number }[];
};

export const FAMILY: Record<Family, { label: string; color: string; hint: string }> = {
  answers: { label: "Read to answer", color: "var(--viz-ai)", hint: "An assistant fetched the page live because someone asked it a question (ChatGPT-User, Claude-User, Perplexity-User...). The closest thing to being cited." },
  ai_search: { label: "AI search index", color: "oklch(0.68 0.13 280)", hint: "An assistant's search engine indexed the page, so it can show up in answers (OAI-SearchBot, Claude-SearchBot, PerplexityBot)." },
  ai_training: { label: "AI training", color: "oklch(0.78 0.07 293)", hint: "Collected to train models (GPTBot, ClaudeBot, meta-externalagent, CCBot...). A distant effect." },
  search: { label: "Search engines", color: "var(--viz-traffic)", hint: "Googlebot, Bingbot... Classic search indexing." },
  preview: { label: "Link previews", color: "oklch(0.75 0.1 200)", hint: "A link was shared in Slack, LinkedIn, WhatsApp... and its preview fetched." },
  seo: { label: "SEO tools", color: "oklch(0.8 0.02 260)", hint: "Ahrefs, Semrush, DataForSEO... crawling for their own index." },
  other: { label: "Other bots", color: "oklch(0.86 0.01 260)", hint: "Monitoring, feeds, archivers and anything else Cloudflare verified." },
};
const ORDER: Family[] = ["answers", "ai_search", "ai_training", "search", "preview", "seo", "other"];
const KIND: Record<string, string> = { page: "Pages", twin: "Markdown twins (.md)", llms: "llms.txt", feed: "Sitemaps, robots, feeds", og: "Social images", asset: "Assets" };

function FamilyCard({ f, d, on, onPick }: { f: Family; d: Data; on: boolean; onPick: () => void }) {
  const meta = FAMILY[f];
  return (
    <button type="button" aria-pressed={on} onClick={onPick}
      className={cn("relative flex min-w-0 flex-col gap-1 bg-background px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50")}>
      <span className="flex items-center gap-1.5 truncate text-xs leading-5 text-muted-foreground">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: meta.color }} />
        <Hint content={meta.hint}>{meta.label}</Hint>
      </span>
      <span className="flex items-end justify-between gap-2">
        <span className="flex flex-col">
          <span className="text-xl leading-7 font-semibold tracking-tight tabular-nums">{compact(d.totals[f] ?? 0)}</span>
          <ChangeBadge now={d.totals[f]} before={d.previous?.[f]} className="h-4" />
        </span>
        <Spark series={d.series.map((p) => p[f] ?? 0)} color={meta.color} className="mb-1 h-7 w-16" />
      </span>
      <span aria-hidden="true" className={cn("absolute inset-x-0 bottom-0 h-0.5", on ? "opacity-100" : "opacity-0")} style={{ background: meta.color }} />
    </button>
  );
}

function Chart({ d, family }: { d: Data; family: Family | null }) {
  const shown = family ? [family] : ORDER.filter((f) => (d.totals[f] ?? 0) > 0);
  const config = Object.fromEntries(shown.map((f) => [f, { label: FAMILY[f].label, color: FAMILY[f].color }])) satisfies ChartConfig;
  const byDay = new Map(d.series.map((p) => [p.day, p]));
  const data = Array.from({ length: d.days }, (_, i) => {
    const k = new Date(Date.parse(`${d.from}T00:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
    return { day: k, ...(byDay.get(k) ?? {}) };
  });
  return (
    <ChartContainer config={config} className="aspect-auto h-64 w-full">
      <BarChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barCategoryGap="20%">
        <CartesianGrid vertical={false} strokeDasharray="3 4" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={10} minTickGap={40} interval="preserveStartEnd" tickFormatter={day} />
        <YAxis width={40} tickLine={false} axisLine={false} tickMargin={4} allowDecimals={false} tickFormatter={compact} />
        <ChartTooltip isAnimationActive={false} cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
          content={({ active, payload }) => {
            const p = active ? (payload?.[0]?.payload as Record<string, any> | undefined) : undefined;
            if (!p) return null;
            return (
              <div className="grid min-w-48 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs shadow-sm">
                <span className="text-muted-foreground first-letter:uppercase">{dayFull(p.day)}{p.live ? " · so far" : ""}</span>
                {shown.filter((f) => p[f]).map((f) => (
                  <span key={f} className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: FAMILY[f].color }} />{FAMILY[f].label}</span>
                    <span className="font-medium tabular-nums">{num(p[f])}</span>
                  </span>
                ))}
              </div>
            );
          }} />
        {shown.map((f, i) => <Bar key={f} dataKey={f} stackId="b" fill={`var(--color-${f})`} radius={i === shown.length - 1 ? [3, 3, 0, 0] : 0} maxBarSize={22} isAnimationActive={false} />)}
      </BarChart>
    </ChartContainer>
  );
}

function SmallList({ title, rows, name, hint }: { title: string; rows: { k: string; n: number }[]; name?: (k: string) => string; hint?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-background">
      <header className="flex items-center justify-between border-b px-4 py-2.5"><h2 className="text-sm font-medium">{hint ? <Hint content={hint}>{title}</Hint> : title}</h2><span className="text-xs text-muted-foreground">Requests</span></header>
      <ul className="flex flex-col gap-0.5 p-1.5">
        {rows.length ? rows.map((r) => (
          <li key={r.k} className="relative flex h-8 items-center gap-2.5 px-2 text-sm">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-md" style={{ width: `${Math.max((r.n / max) * 100, 1.5)}%`, background: "color-mix(in oklch, var(--viz-ai) 13%, transparent)" }} />
            <span className="relative min-w-0 flex-1 truncate">{name ? name(r.k) : r.k}</span>
            <span className="relative font-medium tabular-nums">{num(r.n)}</span>
          </li>
        )) : <li className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">Nothing in the period</li>}
      </ul>
    </section>
  );
}

export function AiScreen({ me }: { me: Me }) {
  const { params } = useRoute();
  const days = periodFrom(params);
  const family = (params.get("family") as Family | null) ?? null;
  const bot = params.get("bot");
  const site = params.get("site") ?? "*";
  const q = `/api/bots?site=${encodeURIComponent(site)}&days=${days}${family ? `&family=${family}` : ""}${bot ? `&bot=${encodeURIComponent(bot)}` : ""}`;
  const { data: d, error, current, reload } = useData<Data>(q);
  const sites = d?.sites ?? me.products.map((p) => ({ id: p.id, name: p.name, zone: p.domain }));
  const siteName = (id: string) => (id === "*" ? "All products" : (sites.find((s) => s.id === id)?.name ?? id));
  const aiTotal = d ? d.totals.answers + d.totals.ai_search + d.totals.ai_training : 0;
  const share = d && d.traffic.bot + d.traffic.other ? Math.round((d.traffic.bot / (d.traffic.bot + d.traffic.other)) * 100) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="AI & bots" meta={d ? `${num(aiTotal)} requests from AI${share !== null ? ` · bots are ${share}% of all requests` : ""}` : "What assistants and crawlers read on your sites"}>
        <Select value={site} onValueChange={(v) => patchParams({ site: v === "*" ? null : String(v), bot: null })}>
          <SelectTrigger aria-label="Site" className="min-w-40">
            <SelectValue>{(v: string) => (v === "*" ? "All products" : <span className="flex items-center gap-2"><ProductIcon id={v} name={siteName(v)} className="size-5 rounded-md" />{siteName(v)}</span>)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All products</SelectItem>
            {sites.map((s) => <SelectItem key={s.id} value={s.id}><span className="flex items-center gap-2"><ProductIcon id={s.id} name={s.name} className="size-5 rounded-md" />{s.name}</span></SelectItem>)}
          </SelectContent>
        </Select>
        <PeriodControl days={days} onChange={(n) => patchParams({ days: n })} />
      </PageHeader>
      <ErrorNote error={error} onRetry={reload} />

      {(family || bot) && (
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          {family && <Chip label="Family" value={FAMILY[family].label} onClear={() => patchParams({ family: null })} />}
          {bot && <Chip label="Bot" value={bot} icon={<ValueIcon dim="bot" k={bot} />} onClear={() => patchParams({ bot: null })} />}
        </div>
      )}

      <section className={cn("@container overflow-hidden rounded-xl border bg-background transition-opacity", !current && "opacity-60")} aria-busy={!d || !current}>
        <div className="grid grid-cols-2 gap-px border-b bg-border @2xl:grid-cols-4 @5xl:grid-cols-7">
          {d ? ORDER.map((f) => <FamilyCard key={f} f={f} d={d} on={family === f} onPick={() => patchParams({ family: family === f ? null : f })} />)
            : ORDER.map((f) => <div key={f} className="flex flex-col gap-2 bg-background px-4 py-3"><span className="h-4 w-16 animate-pulse rounded-sm bg-muted" /><span className="h-7 w-20 animate-pulse rounded-sm bg-muted" /></div>)}
        </div>
        <div className="px-2 pt-5 pb-2">{d ? <Chart d={d} family={family} /> : <div className="h-64 animate-pulse rounded-lg bg-muted/50" />}</div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown title="Pages read to answer" dimensions={[{ key: "answers", label: "Pages read to answer", rows: d?.pages.answers.map((p) => ({ k: p.k, count: p.n })), by: "count", column: "Reads", tone: "ai" }]} />
        <Breakdown title="Pages crawled by AI" dimensions={[{ key: "crawl", label: "Pages crawled by AI (index and training)", rows: d?.pages.crawl.map((p) => ({ k: p.k, count: p.n })), by: "count", column: "Requests", tone: "ai" }]} />
      </div>

      <section className={cn("@container overflow-hidden rounded-xl border bg-background transition-opacity", !current && "opacity-60")} aria-label="Bots">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Bot</TableHead>
              <TableHead className="w-40">Family</TableHead>
              <TableHead className="hidden @3xl:table-cell">Most read</TableHead>
              <TableHead className="hidden w-20 text-right @xl:table-cell">Days</TableHead>
              <TableHead className="hidden w-24 text-right @xl:table-cell">Errors</TableHead>
              <TableHead className="w-28 pr-4 text-right">Requests</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d ? d.bots.map((b) => (
              <TableRow key={b.bot} className={cn("cursor-pointer", bot === b.bot && "bg-muted/50")} onClick={() => patchParams({ bot: bot === b.bot ? null : b.bot })}>
                <TableCell className="pl-4"><span className="flex min-w-0 items-center gap-2.5"><ValueIcon dim="bot" k={b.bot} /><span className="truncate font-medium">{b.bot}</span></span></TableCell>
                <TableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className="size-2 shrink-0 rounded-full" style={{ background: FAMILY[b.family].color }} /><span className="truncate">{FAMILY[b.family].label}</span></span></TableCell>
                <TableCell className="hidden truncate font-mono text-[13px] text-muted-foreground @3xl:table-cell" title={b.pages.map((p) => p.k).join("  ")}>{b.pages.slice(0, 3).map((p) => p.k).join("  ") || "–"}</TableCell>
                <TableCell className="hidden text-right tabular-nums text-muted-foreground @xl:table-cell">{b.days}</TableCell>
                <TableCell className={cn("hidden text-right tabular-nums @xl:table-cell", b.errors ? "text-down" : "text-muted-foreground")}>{b.errors ? num(b.errors) : "–"}</TableCell>
                <TableCell className="pr-4 text-right font-medium tabular-nums">{num(b.requests)}</TableCell>
              </TableRow>
            )) : Array.from({ length: 6 }, (_, i) => <TableRow key={i}><TableCell colSpan={6} className="px-4"><span className="block h-6 animate-pulse rounded bg-muted" /></TableCell></TableRow>)}
            {d && !d.bots.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">No bot in the period</TableCell></TableRow>}
          </TableBody>
        </Table>
      </section>

      {d && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <SmallList title="What AI fetched" hint="Pages, Markdown twins, llms.txt, sitemaps... requested by AI bots." rows={d.kinds} name={(k) => KIND[k] ?? k} />
          <SmallList title="Responses served to AI" hint="HTTP status of AI bot requests: 4xx and 5xx are pages they could not read." rows={d.statuses} name={(k) => (k === "200" ? "200 OK" : k === "404" ? "404 Not found" : k === "301" || k === "308" ? `${k} Redirect` : k)} />
          {d.delivery.length > 0
            ? <SmallList title="Formats served to agents" hint="From the site's own Worker: the format each agent got, and the MCP tools it called." rows={d.delivery.map((x) => ({ k: x.tool ? `${x.format} · ${x.tool}` : x.format, n: x.calls }))} />
            : <SmallList title="Where AI crawlers run" hint="Country of the crawler's servers (index and training), not of the people asking." rows={d.countries} />}
        </div>
      )}
    </div>
  );
}

function Chip({ label, value, icon, onClear }: { label: string; value: string; icon?: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background pr-1 pl-2.5 text-[13px]">
      <span className="text-muted-foreground">{label}</span>{icon}<span className="max-w-60 truncate font-medium">{value}</span>
      <button type="button" aria-label="Remove filter" onClick={onClear} className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"><X className="size-3.5" /></button>
    </span>
  );
}
