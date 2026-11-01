/*
  A breakdown panel: tabs for the dimensions of one question (where from: channels, sites, AI
  assistants, campaigns), the top rows with a coloured bar behind each, the whole list in a side
  sheet. A row is a button: it filters the whole screen on that value (Rybbit's model), a second
  click removes the filter.
*/
import { useState } from "react";
import type { Top } from "@/lib/api";
import { num } from "@/lib/fmt";
import { cn } from "@/lib/utils";
import { ValueIcon } from "@/components/icons";
import { TONE, type Tone } from "@/components/trend";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type Dimension = {
  key: string;
  label: string;
  /** The filter dimension a click sets (server: src/explore.ts); absent = not filterable. */
  dim?: string;
  rows: Top[] | undefined;
  by: "views" | "visits" | "visitors" | "count";
  column: string;
  second?: { by: "visitors" | "users" | "visits"; column: string };
  name?: (k: string) => React.ReactNode;
  tone?: Tone;
};

const region = new Intl.DisplayNames(["en"], { type: "region" });
const language = new Intl.DisplayNames(["en"], { type: "language" });
export const countryName = (k: string) => { try { return k && k.length === 2 && k !== "??" ? region.of(k.toUpperCase()) ?? k : "Unknown"; } catch { return k; } };
export const languageName = (k: string) => { try { return k && k !== "?" ? language.of(k) ?? k : "Unknown"; } catch { return k; } };

type RowsProps = { d: Dimension; rows: Top[]; limit?: number; active: Set<string>; onPick?: (dim: string, k: string) => void; format?: (v: number) => string };

function Rows({ d, rows, limit, active, onPick, format = num }: RowsProps) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(1, ...rows.map((r) => r[d.by] ?? 0));
  const total = rows.reduce((t, r) => t + (r[d.by] ?? 0), 0) || 1;
  const color = TONE[d.tone ?? "traffic"];
  return (
    <ul className="flex flex-col gap-0.5">
      {shown.map((r) => {
        const v = r[d.by] ?? 0;
        const on = !!d.dim && active.has(`${d.dim}:${r.k}`);
        const inner = (
          <>
            <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-md" style={{ width: `${Math.max((v / max) * 100, 1.5)}%`, background: `color-mix(in oklch, ${color} ${on ? 26 : 13}%, transparent)` }} />
            {d.dim && <span className="relative"><ValueIcon dim={d.dim} k={r.k} /></span>}
            <span className="relative min-w-0 flex-1 truncate text-left" title={r.k}>{d.name ? d.name(r.k) : r.k || "(empty)"}</span>
            <span className="relative shrink-0 text-xs text-muted-foreground tabular-nums opacity-0 group-hover/row:opacity-100">{Math.round((v / total) * 1000) / 10}%</span>
            {!limit && d.second && <span className="relative w-20 text-right tabular-nums text-muted-foreground">{num(r[d.second.by])}</span>}
            <span className="relative min-w-14 text-right font-medium tabular-nums">{format(v)}</span>
          </>
        );
        const cls = "group/row relative flex h-8 w-full items-center gap-2.5 px-2 text-sm";
        return (
          <li key={r.k}>
            {d.dim && onPick ? (
              <button type="button" aria-pressed={on} title={on ? "Remove the filter" : "Filter on this value"} onClick={() => onPick(d.dim!, r.k)}
                className={cn(cls, "rounded-md outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50", on && "font-medium")}>
                {inner}
              </button>
            ) : <div className={cls}>{inner}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function Breakdown({ title, dimensions, limit = 8, active = new Set(), onPick, format, className }: {
  title: string; dimensions: Dimension[]; limit?: number; active?: Set<string>; onPick?: (dim: string, k: string) => void; format?: (v: number) => string; className?: string;
}) {
  const [tab, setTab] = useState(dimensions[0]!.key);
  const [open, setOpen] = useState(false);
  const d = dimensions.find((x) => x.key === tab) ?? dimensions[0]!;
  const rows = d.rows ?? [];
  const pick = onPick ? (dim: string, k: string) => { setOpen(false); onPick(dim, k); } : undefined;
  return (
    <section className={cn("flex min-w-0 flex-col rounded-xl border bg-background", className)} aria-label={title}>
      <header className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
        {dimensions.length > 1 ? (
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-w-0 overflow-x-auto [scrollbar-width:none]">
            <TabsList variant="line" className="h-8">
              {dimensions.map((x) => <TabsTrigger key={x.key} value={x.key} className="px-2 text-[0.8125rem]">{x.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        ) : (
          <h2 className="px-2 text-sm font-medium">{d.label}</h2>
        )}
        <span className="shrink-0 px-2 text-xs text-muted-foreground">{d.column}</span>
      </header>
      <div className="flex flex-1 flex-col p-1.5">
        {d.rows === undefined ? (
          <div className="flex flex-col gap-1.5 p-1">{Array.from({ length: 5 }, (_, i) => <span key={i} className="h-7 animate-pulse rounded-md bg-muted/60" style={{ width: `${90 - i * 14}%` }} />)}</div>
        ) : rows.length ? (
          <Rows d={d} rows={rows} limit={limit} active={active} onPick={pick} format={format} />
        ) : (
          <p className="flex min-h-40 flex-1 items-center justify-center text-sm text-muted-foreground">Nothing in this period</p>
        )}
      </div>
      {rows.length > limit && (
        <button type="button" onClick={() => setOpen(true)} className="border-t px-4 py-2 text-left text-[0.8125rem] text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50">
          See all {rows.length}
        </button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle>{d.label === title ? title : `${title} · ${d.label}`}</SheetTitle>
          </SheetHeader>
          <div className="flex items-center justify-end gap-3 px-6 pt-3 pb-1 text-xs text-muted-foreground">
            {d.second && <span className="w-20 text-right">{d.second.column}</span>}
            <span className="w-14 text-right">{d.column}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6"><Rows d={d} rows={rows} active={active} onPick={pick} format={format} /></div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
