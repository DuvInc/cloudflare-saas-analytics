/*
  Every funnel of every product, the busiest first. Funnels are defined in code
  (funnels/<product>.json) and changed by asking the agent, so this screen only reads: one card
  per funnel, its steps as horizontal bars (the share of people who started), the loss and median
  time between steps, and which channels convert.
*/
import { Info } from "lucide-react";
import type { Me } from "@/lib/api";
import { duration, num } from "@/lib/fmt";
import { navigate, patchParams, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { PeriodControl, periodFrom } from "@/components/period";
import { ProductIcon, ValueIcon } from "@/components/icons";
import { ErrorNote } from "@/components/notes";
import { TONE } from "@/components/trend";
import { Hint } from "@/components/ui/help-tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Step = { kind: "page" | "event"; value: string; people: number; median_ms: number | null };
type Funnel = { id: string; product: string; name: string; description: string; steps: Step[]; byChannel: { k: string; entered: number; converted: number }[]; entered: number; converted: number; unavailable?: string };

const share = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const pct = (a: number, b: number) => `${Math.round(share(a, b) * 10) / 10}%`;
const label = (s: { kind: string; value: string }) => (s.kind === "page" ? (s.value === "*" ? "Any page" : s.value) : s.value.replace(/_/g, " "));

function FunnelCard({ f, productName }: { f: Funnel; productName: string }) {
  if (f.unavailable) return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border bg-background p-5">
      <header className="flex items-center gap-3"><ProductIcon id={f.product} name={productName} /><span className="font-semibold">{f.name}</span></header>
      <p className="text-sm text-muted-foreground">Not measurable: {f.unavailable}</p>
    </article>
  );
  const first = f.steps[0]?.people ?? 0;
  const idle = first === 0;
  return (
    <article className={cn("flex min-w-0 flex-col gap-4 rounded-xl border bg-background p-5", idle && "opacity-70")}>
      <header className="flex items-start gap-3">
        <ProductIcon id={f.product} name={productName} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 font-semibold tracking-tight">
            {f.name}
            <Hint content={<span className="flex flex-col gap-1"><span>{f.description}</span><span className="opacity-70">{f.steps.map(label).join(" → ")}</span></span>}>
              <Info className="size-3.5 text-muted-foreground" aria-label="About this funnel" />
            </Hint>
          </span>
          <span className="text-xs text-muted-foreground">{productName}</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-2xl leading-7 font-semibold tracking-tight tabular-nums" style={{ color: idle ? undefined : TONE.signup }}>{idle ? "–" : pct(f.converted, first)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{num(f.converted)} of {num(first)}</span>
        </div>
      </header>

      {idle ? (
        <p className="text-sm text-muted-foreground">No one started this funnel in the period.</p>
      ) : (
        <ol className="flex flex-col">
          {f.steps.map((s, i) => {
            const prev = i ? f.steps[i - 1]!.people : s.people;
            return (
              <li key={i} className="flex flex-col">
                {i > 0 && (
                  <span className="ml-8 flex h-6 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                    <span style={{ color: prev > s.people ? TONE.money : undefined }}>{prev > s.people ? `−${pct(prev - s.people, prev)}` : "no loss"}</span>
                    {s.median_ms != null && <span>· {duration(s.median_ms)} later</span>}
                  </span>
                )}
                <div className="flex items-center gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-semibold tabular-nums">{i + 1}</span>
                  <div className="relative flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-md bg-muted/50">
                    <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-md" style={{ width: `${Math.max(share(s.people, first), s.people ? 1.5 : 0)}%`, background: `color-mix(in oklch, ${TONE.traffic} ${i === f.steps.length - 1 ? 45 : 22}%, transparent)` }} />
                    <span className={cn("relative truncate px-2.5 text-sm", s.kind === "page" && "font-mono text-[0.8125rem]")} title={label(s)}>{label(s)}</span>
                  </div>
                  <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums">{num(s.people)}</span>
                  <span className="hidden w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">{pct(s.people, first)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {f.byChannel.some((c) => c.converted > 0) && (
        <footer className="flex flex-wrap gap-1.5 border-t pt-3">
          {f.byChannel.filter((c) => c.entered > 0).slice(0, 5).map((c) => {
            const ai = c.k.startsWith("AI · ");
            return (
              <span key={c.k} className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted/60 px-2 text-xs">
                <ValueIcon dim={ai ? "ai" : "channel"} k={ai ? c.k.slice(5) : c.k} />
                {ai ? c.k.slice(5) : c.k}
                <span className="font-medium tabular-nums">{pct(c.converted, c.entered)}</span>
              </span>
            );
          })}
        </footer>
      )}
    </article>
  );
}

export function FunnelsScreen({ me }: { me: Me }) {
  const { params } = useRoute();
  const days = Math.min(periodFrom(params), 90);
  const product = params.get("product") ?? "";
  const { data, error, current, reload } = useData<{ days: number; funnels: Funnel[] }>(`/api/funnels?days=${days}${product ? `&product=${product}` : ""}`);
  const name = (id: string) => me.products.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Funnels" meta={data ? `${data.funnels.length} funnels, the busiest first` : undefined}>
        <Select value={product || "*"} onValueChange={(v) => navigate("/funnels", { product: v === "*" ? null : String(v), days }, { replace: true })}>
          <SelectTrigger aria-label="Product" className="min-w-44">
            <SelectValue>{(v: string) => (v === "*" ? "All products" : <span className="flex items-center gap-2"><ProductIcon id={v} name={name(v)} className="size-5 rounded-md" />{name(v)}</span>)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All products</SelectItem>
            {me.products.map((p) => <SelectItem key={p.id} value={p.id}><span className="flex items-center gap-2"><ProductIcon id={p.id} name={p.name} className="size-5 rounded-md" />{p.name}</span></SelectItem>)}
          </SelectContent>
        </Select>
        <PeriodControl days={days} onChange={(d) => patchParams({ days: Math.min(d, 90) })} />
      </PageHeader>
      <ErrorNote error={error} onRetry={reload} />
      <div className={cn("grid gap-4 transition-opacity xl:grid-cols-2", !current && "opacity-60")}>
        {data
          ? data.funnels.map((f) => <FunnelCard key={`${f.product}:${f.id}`} f={f} productName={name(f.product)} />)
          : !error && Array.from({ length: 4 }, (_, i) => <div key={i} className="h-72 animate-pulse rounded-xl border bg-muted/30" />)}
      </div>
    </div>
  );
}
