/*
  Session replays of signed-in people: the list on the left (filtered by product, person, length,
  errors, a page seen), the chosen session playing on the right. Everything in the address
  (`id`, `product`, `q`, `min`, `errors`, `page`), so a session can be shared and Back works.
*/
import { AlertTriangle, ArrowLeft, MousePointerClick, PlayCircle, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Me } from "@/lib/api";
import { ago, duration, when } from "@/lib/fmt";
import { href, navigate, patchParams, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { PeriodControl, periodFrom } from "@/components/period";
import { ProductIcon } from "@/components/icons";
import { ErrorNote } from "@/components/notes";
import { TONE } from "@/components/trend";
import { Avatar } from "@/screens/people";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Replay = { id: string; product: string; user_id: string; email: string | null; started_at: number; last_at: number; clicks: number; errors: number; pages: string; chunks: number };
const MIN = [["0", "Any length"], ["30", "30s+"], ["60", "1m+"], ["300", "5m+"]] as const;

function loadPlayer(): Promise<void> {
  const w = window as any;
  if (w.csaPlayer) return Promise.resolve();
  if (!document.querySelector('link[href="/player.css"]')) {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "/player.css";
    document.head.appendChild(css);
  }
  return new Promise((ok, ko) => { const s = document.createElement("script"); s.src = "/player.js"; s.onload = () => ok(); s.onerror = () => ko(new Error("The player could not load.")); document.head.appendChild(s); });
}

function Player({ r, productName }: { r: Replay; productName: string }) {
  const { data, error } = useData<{ events: any[] }>(`/api/replay/${r.id}`);
  const el = useRef<HTMLDivElement>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  useEffect(() => {
    if (!data || !el.current || data.events.length < 2) return;
    let cancelled = false;
    loadPlayer().then(() => { if (!cancelled && el.current) (window as any).csaPlayer(el.current, data.events); }).catch((e) => setPlayerError(e.message));
    return () => {
      cancelled = true;
      if (el.current) {
        try { (el.current as any)._csaDestroy?.(); } catch {}
        el.current.innerHTML = "";
      }
    };
  }, [data]);
  const pages: string[] = JSON.parse(r.pages || "[]");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Avatar seed={r.user_id} label={r.email ?? r.user_id} />
        <div className="flex min-w-0 flex-col">
          <a href={href("/people", { open: `${r.product}/${r.user_id}`, tab: "activity" })} className="truncate font-semibold hover:underline">{r.email ?? r.user_id}</a>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ProductIcon id={r.product} name={productName} className="size-4 rounded" />{productName} · {when(r.started_at)} · {duration(r.last_at - r.started_at)} · {r.clicks} clicks{r.errors ? ` · ${r.errors} errors` : ""}</span>
        </div>
      </div>
      <ErrorNote error={error ?? playerError} />
      <div className="overflow-hidden rounded-xl border bg-muted/40">
        {data && data.events.length < 2 ? (
          <p className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">Empty or expired: sessions are kept 30 days.</p>
        ) : (
          <div key={r.id} ref={el} className="csa-player w-full lg:min-h-[26rem]">{!data && <div className="aspect-video animate-pulse lg:aspect-auto lg:h-[26rem]" />}</div>
        )}
      </div>
      {pages.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {pages.map((p, i) => <span key={i} className="rounded-md bg-muted/60 px-2 py-1 font-mono">{p}</span>)}
        </div>
      )}
    </div>
  );
}

export function ReplaysScreen({ me }: { me: Me }) {
  const { params } = useRoute();
  const days = periodFrom(params);
  const product = params.get("product") ?? "";
  const q = params.get("q") ?? "";
  const min = params.get("min") ?? "0";
  const errorsOnly = params.get("errors") === "1";
  const page = params.get("page") ?? "";
  const [text, setText] = useState(q);
  const [pageText, setPageText] = useState(page);
  useEffect(() => { const t = setTimeout(() => (text !== q || pageText !== page) && patchParams({ q: text || null, page: pageText || null }), 250); return () => clearTimeout(t); }, [text, pageText]);
  const { data, error, current, reload } = useData<{ replays: Replay[] }>(`/api/replays?days=${days}${product ? `&product=${product}` : ""}`);
  const name = (id: string) => me.products.find((p) => p.id === id)?.name ?? id;
  const list = (data?.replays ?? []).filter((r) =>
    (!q || (r.email ?? r.user_id).toLowerCase().includes(q.toLowerCase())) &&
    (r.last_at - r.started_at) / 1000 >= Number(min) &&
    (!errorsOnly || r.errors > 0) &&
    (!page || (r.pages || "").toLowerCase().includes(page.toLowerCase())));
  /* Phones show one screen at a time: the list, or the chosen session. */
  const chosen = !!params.get("id");
  const selected = list.find((r) => r.id === params.get("id")) ?? (data?.replays ?? []).find((r) => r.id === params.get("id")) ?? list[0];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader className={cn(chosen && "hidden lg:flex")} title="Replays" meta={data ? `${list.length} of ${data.replays.length} sessions` : undefined}>
        <Select value={product || "*"} onValueChange={(v) => patchParams({ product: v === "*" ? null : String(v), id: null })}>
          <SelectTrigger aria-label="Product" className="min-w-40"><SelectValue>{(v: string) => (v === "*" ? "All products" : <span className="flex items-center gap-2"><ProductIcon id={v} name={name(v)} className="size-5 rounded-md" />{name(v)}</span>)}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All products</SelectItem>
            {me.products.map((p) => <SelectItem key={p.id} value={p.id}><span className="flex items-center gap-2"><ProductIcon id={p.id} name={p.name} className="size-5 rounded-md" />{p.name}</span></SelectItem>)}
          </SelectContent>
        </Select>
        <PeriodControl days={days} onChange={(d) => patchParams({ days: d })} />
      </PageHeader>

      <div className={cn("flex flex-wrap items-center gap-2", chosen && "hidden lg:flex")}>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Person" aria-label="Person" className="h-8 w-48 pl-8 text-[0.8125rem]" />
        </div>
        <Input value={pageText} onChange={(e) => setPageText(e.target.value)} placeholder="Page seen: /billing" aria-label="Page seen" className="h-8 w-48 font-mono text-[0.8125rem]" />
        <ToggleGroup variant="segmented" value={[min]} onValueChange={(v: string[]) => v[0] && patchParams({ min: v[0] === "0" ? null : v[0] })} aria-label="Minimum length">
          {MIN.map(([k, l]) => <ToggleGroupItem key={k} value={k} className="px-2.5 text-[0.8125rem]">{l}</ToggleGroupItem>)}
        </ToggleGroup>
        <button type="button" aria-pressed={errorsOnly} onClick={() => patchParams({ errors: errorsOnly ? null : 1 })}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.8125rem] outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50", errorsOnly && "border-foreground")}>
          <AlertTriangle className="size-3.5" style={{ color: TONE.money }} />With errors
        </button>
      </div>
      <ErrorNote error={error} onRetry={reload} />

      <div className={cn("grid gap-4 transition-opacity lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]", !current && "opacity-60")}>
        <ul className={cn("flex min-w-0 flex-col gap-1 overflow-y-auto rounded-xl border bg-background p-1.5 lg:max-h-[calc(100svh-15rem)]", chosen && "hidden lg:flex")} aria-label="Sessions">
          {data && list.length === 0 && <li className="px-3 py-10 text-center text-sm text-muted-foreground">No session matches.</li>}
          {!data && Array.from({ length: 6 }, (_, i) => <li key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />)}
          {list.map((r) => {
            const on = r.id === selected?.id;
            const pages: string[] = JSON.parse(r.pages || "[]");
            return (
              <li key={r.id}>
                <button type="button" onClick={() => (window.matchMedia("(min-width: 1024px)").matches ? patchParams({ id: r.id }) : navigate("/replays", { ...Object.fromEntries(params), id: r.id }))} aria-current={on ? "true" : undefined}
                  className={cn("flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", on && "bg-muted")}>
                  <span className="flex items-center gap-2">
                    <ProductIcon id={r.product} name={name(r.product)} className="size-5 rounded-md" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.email ?? r.user_id}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{ago(r.started_at)}</span>
                  </span>
                  <span className="flex items-center gap-3 pl-7 text-xs text-muted-foreground tabular-nums">
                    <span className="flex items-center gap-1"><PlayCircle className="size-3.5" />{duration(r.last_at - r.started_at)}</span>
                    <span className="flex items-center gap-1"><MousePointerClick className="size-3.5" />{r.clicks}</span>
                    {r.errors > 0 && <span className="flex items-center gap-1" style={{ color: TONE.money }}><AlertTriangle className="size-3.5" />{r.errors}</span>}
                    <span className="min-w-0 flex-1 truncate font-mono">{pages.slice(0, 3).join(" → ")}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className={cn("min-w-0", !chosen && "hidden lg:block")}>
          {chosen && <button type="button" onClick={() => history.length > 1 ? history.back() : patchParams({ id: null })} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground lg:hidden"><ArrowLeft className="size-4" />All sessions</button>}
          {selected ? <Player key={selected.id} r={selected} productName={name(selected.product)} />
            : data && <p className="flex h-80 items-center justify-center rounded-xl border text-sm text-muted-foreground">Only signed-in people are recorded.</p>}
        </div>
      </div>
    </div>
  );
}
