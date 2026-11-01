/*
  The filters of a product screen. Three ways to set one: click a row of a breakdown, build it
  ("+ Filter": dimension, operator, value), or describe it ("French traffic on my blog": a small
  model turns the sentence into filters, server side, src/ai-filter.ts). In the address as
  `f=dim:value|dim!:value|dim~:value` (is, is not, contains).
*/
import { Filter as FilterIcon, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, features } from "@/lib/api";
import { cn } from "@/lib/utils";
import { countryName, languageName } from "@/components/breakdown";
import { ValueIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const DIM_LABEL: Record<string, string> = {
  channel: "Channel", referrer: "Referrer", ai: "AI assistant", utm_source: "UTM source", utm_campaign: "Campaign", entry: "Entry page",
  page: "Page", country: "Country", city: "City", device: "Device", browser: "Browser", os: "OS", lang: "Language", event: "Event",
};
const OPS = { is: "is", not: "is not", contains: "contains" } as const;
type Op = keyof typeof OPS;
const DEVICE: Record<string, string> = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet" };
export const valueLabel = (dim: string, k: string) => (dim === "country" ? countryName(k) : dim === "lang" ? languageName(k) : dim === "device" ? DEVICE[k] ?? k : k);

export type ParsedFilter = { raw: string; dim: string; op: Op; value: string };
export function parse(raw: string): ParsedFilter | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  let dim = raw.slice(0, i);
  let op: Op = "is";
  if (dim.endsWith("!")) { op = "not"; dim = dim.slice(0, -1); } else if (dim.endsWith("~")) { op = "contains"; dim = dim.slice(0, -1); }
  return { raw, dim, op, value: raw.slice(i + 1) };
}
export const encode = (dim: string, op: Op, value: string) => `${dim}${op === "not" ? "!" : op === "contains" ? "~" : ""}:${value}`;
export const readFilters = (params: URLSearchParams) => (params.get("f") ?? "").split("|").filter((x) => x.includes(":"));

/** A new filter replaces any other on the same dimension and operator. */
export function withFilter(list: string[], raw: string): string[] {
  const p = parse(raw)!;
  return [...list.filter((x) => { const q = parse(x); return !(q && q.dim === p.dim && q.op === p.op); }), raw];
}

function FilterControl({
  product,
  options,
  onAdd,
  onAiFilters,
}: {
  product: string;
  options: Record<string, string[]>;
  onAdd: (raw: string) => void;
  onAiFilters: (raws: string[]) => void;
}) {
  const [builderOpen, setBuilderOpen] = useState(false);
  const [dim, setDim] = useState("page");
  const [op, setOp] = useState<Op>("contains");
  const [value, setValue] = useState("");

  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (aiOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [aiOpen]);

  const add = () => {
    if (!value.trim()) return;
    onAdd(encode(dim, op, value.trim()));
    setValue("");
    setBuilderOpen(false);
  };

  async function ask() {
    if (!aiText.trim() || aiBusy) return;
    setAiBusy(true);
    setAiNote(null);
    try {
      const r = await api<{ filters: { dim: string; op: Op; value: string }[] }>("/api/ai/filter", {
        method: "POST",
        body: JSON.stringify({ product, text: aiText }),
      });
      if (!r.filters.length) {
        setAiNote("No filter matches that description.");
      } else {
        onAiFilters(r.filters.map((f) => encode(f.dim, f.op, f.value)));
        setAiText("");
        setAiOpen(false);
      }
    } catch (e) {
      setAiNote((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "inline-flex h-8 items-stretch rounded-lg border border-border bg-background shadow-2xs transition-all",
        aiOpen && "ring-2 ring-ring/30 border-ring/50"
      )}
    >
      <Popover open={builderOpen} onOpenChange={(o) => { setBuilderOpen(o); if (o) setAiOpen(false); }}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-2.5 rounded-l-lg text-[0.8125rem] font-medium outline-none hover:bg-muted/50 focus-visible:bg-muted transition-colors cursor-pointer"
            >
              <Plus className="size-3.5 text-muted-foreground" />
              <span>Filter</span>
            </button>
          }
        />
        <PopoverContent align="start" className="flex w-80 flex-col gap-2 p-3">
          <div className="flex gap-2">
            <Select value={dim} onValueChange={(v) => { setDim(String(v)); setValue(""); }}>
              <SelectTrigger aria-label="Dimension" className="flex-1"><SelectValue>{(v: string) => DIM_LABEL[v]}</SelectValue></SelectTrigger>
              <SelectContent>{Object.entries(DIM_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={op} onValueChange={(v) => setOp(v as Op)}>
              <SelectTrigger aria-label="Operator" className="w-28"><SelectValue>{(v: string) => OPS[v as Op]}</SelectValue></SelectTrigger>
              <SelectContent>{Object.entries(OPS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} list="filter-values" placeholder="Value" aria-label="Value" />
          <datalist id="filter-values">{(options[dim] ?? []).slice(0, 60).map((v) => <option key={v} value={v}>{valueLabel(dim, v)}</option>)}</datalist>
          <Button size="sm" onClick={add} disabled={!value.trim()}>Apply</Button>
        </PopoverContent>
      </Popover>

      {features.ai && <span className="my-auto h-4 w-px bg-border shrink-0" aria-hidden="true" />}

      {!features.ai ? null : !aiOpen ? (
        <button
          type="button"
          onClick={() => {
            setAiOpen(true);
            setAiNote(null);
            setBuilderOpen(false);
          }}
          className="inline-flex items-center justify-center px-2.5 rounded-r-lg text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted transition-colors cursor-pointer"
          aria-label="Describe a filter with AI"
          title="Describe a filter with AI"
        >
          <Sparkles className="size-3.5" style={{ color: "var(--viz-ai)" }} />
        </button>
      ) : (
        <div className="relative flex items-center pl-2 pr-1 w-64 sm:w-80 h-full">
          <Sparkles className="pointer-events-none size-3.5 shrink-0" style={{ color: "var(--viz-ai)" }} />
          <input
            ref={inputRef}
            value={aiText}
            onChange={(e) => setAiText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ask();
              } else if (e.key === "Escape") {
                setAiOpen(false);
                setAiNote(null);
              }
            }}
            onBlur={(e) => {
              if (containerRef.current?.contains(e.relatedTarget as Node)) return;
              if (!aiText.trim() && !aiBusy) {
                setAiOpen(false);
                setAiNote(null);
              }
            }}
            disabled={aiBusy}
            placeholder="Describe a filter: French traffic on my blog"
            aria-label="Describe a filter"
            className="h-full w-full bg-transparent px-2 text-[0.8125rem] outline-none placeholder:text-muted-foreground"
          />
          {aiBusy ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0" />
          ) : (
            <button
              type="button"
              aria-label="Close"
              onClick={() => {
                setAiOpen(false);
                setAiNote(null);
              }}
              className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground shrink-0 cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          )}
          {aiNote && (
            <span
              role="status"
              className="absolute top-full left-0 z-10 mt-1 whitespace-nowrap rounded-md border bg-popover px-2 py-0.5 text-xs text-popover-foreground shadow-sm"
            >
              {aiNote}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function FilterBar({ product, filters, options, onChange, className }: {
  product: string; filters: string[]; options: Record<string, string[]>; onChange: (next: string[]) => void; className?: string;
}) {
  const parsed = filters.map(parse).filter(Boolean) as ParsedFilter[];
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <FilterControl
        product={product}
        options={options}
        onAdd={(raw) => onChange(withFilter(filters, raw))}
        onAiFilters={(raws) => onChange(raws.reduce(withFilter, filters))}
      />
      {parsed.map((f) => (
        <span key={f.raw} className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background pr-1 pl-2.5 text-[0.8125rem]">
          <FilterIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{DIM_LABEL[f.dim] ?? f.dim} {OPS[f.op]}</span>
          {f.op !== "contains" && <ValueIcon dim={f.dim} k={f.value} />}
          <span className="max-w-60 truncate font-medium">{f.op === "contains" ? `"${f.value}"` : valueLabel(f.dim, f.value)}</span>
          <button type="button" aria-label="Remove the filter" onClick={() => onChange(filters.filter((x) => x !== f.raw))}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"><X className="size-3.5" /></button>
        </span>
      ))}
      {parsed.length > 1 && <button type="button" onClick={() => onChange([])} className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Clear all</button>}
    </div>
  );
}
