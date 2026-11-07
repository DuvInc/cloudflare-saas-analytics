/*
  The people (product accounts) of every product: who they are, where they came from, what they
  paid, and what they did. A row opens the person in a wide side sheet (design system: a record
  opens in a sheet) with four tabs: profile, activity (their visits, page by page and event by
  event, the anonymous visits before sign-up included), replays and payments. The open person,
  the tab and the filters live in the address.
*/
import { ArrowDown, ArrowUp, ChevronsUpDown, CreditCard, MousePointerClick, PlayCircle, Search, Server, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { Me } from "@/lib/api";
import { ago, duration, money, num, when } from "@/lib/fmt";
import { href, patchParams, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell";
import { ErrorNote } from "@/components/notes";
import { KV } from "@/components/kv";
import { Source } from "@/components/source";
import { countryName } from "@/components/breakdown";
import { ProductIcon, ValueIcon } from "@/components/icons";
import { TONE } from "@/components/trend";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Person = { product: string; user_id: string; email: string | null; name: string | null; plan: string | null; created_at: string; last_seen_at: string | null; ltv_cents: number; currency: string | null; attribution_method: string | null; channel: string | null; ai_source: string | null; referrer_host: string | null; country: string | null; replays: number };
type Activity = { at: number; event: string; origin: string; host: string; path: string; channel: string; ai_source: string | null; referrer_host: string | null; country: string; city: string | null; device: string; browser: string; os: string; engaged_ms: number | null; props: string | null };
const SORTS: Record<string, string> = { newest: "Newest", "-last_seen": "Last seen", "-replays": "Most replays" };
const METHOD: Record<string, string> = { cookie: "Cookie (exact)", hash: "Same device, same day", utm_on_signup: "UTM at sign-up", none: "Unknown" };

function SortableHead({ label, sortKey, sort, className }: { label: string; sortKey: string; sort: string; className?: string }) {
  const active = sort === sortKey || sort === `-${sortKey}`;
  const desc = sort === `-${sortKey}`;
  const Icon = active ? (desc ? ArrowDown : ArrowUp) : ChevronsUpDown;
  return (
    <TableHead className={className} aria-sort={active ? (desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => patchParams({ sort: !active ? sortKey : desc ? null : `-${sortKey}` })}
        className={cn("group/sort inline-flex items-center gap-1 rounded-md px-1 py-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/25", active && "text-foreground")}>
        {label}<Icon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground", !active && "opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100")} />
      </button>
    </TableHead>
  );
}

/** Initials on a colour picked from the id, stable for a person. */
export function Avatar({ seed, label, className }: { seed: string; label: string; className?: string }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  const initials = label.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return (
    <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold", className)}
      style={{ background: `oklch(0.92 0.05 ${h})`, color: `oklch(0.38 0.1 ${h})` }}>{initials}</span>
  );
}

/** Events grouped into visits: a gap over 30 minutes starts a new one. Newest first. */
function visitsOf(events: Activity[]) {
  const out: { start: number; end: number; events: Activity[] }[] = [];
  for (const e of events) {
    const v = out.at(-1);
    if (v && v.start - e.at < 30 * 60_000) { v.events.push(e); v.start = e.at; }
    else out.push({ start: e.at, end: e.at, events: [e] });
  }
  return out.map((v) => ({ ...v, events: v.events.slice().reverse() }));
}

function ActivityTab({ product, userId }: { product: string; userId: string }) {
  const { data, error } = useData<{ days: number; events: Activity[] }>(`/api/activity/${product}/${encodeURIComponent(userId)}?days=90`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <div className="flex flex-col gap-3">{Array.from({ length: 4 }, (_, i) => <span key={i} className="h-20 animate-pulse rounded-lg bg-muted/60" />)}</div>;
  const visits = visitsOf(data.events.filter((e) => e.event !== "$pageleave" && e.event !== "$consent"));
  if (!visits.length) return <p className="py-10 text-center text-sm text-muted-foreground">No activity in the last 90 days.</p>;
  return (
    <ol className="flex flex-col gap-4">
      {visits.map((v) => {
        const entry = v.events.find((e) => e.event === "$pageview");
        return (
          <li key={v.start} className="rounded-lg border">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-2 text-xs">
              <span className="font-medium text-foreground">{when(v.start)}</span>
              {v.end > v.start && <span className="text-muted-foreground">{duration(v.end - v.start)}</span>}
              {entry && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <ValueIcon dim={entry.ai_source ? "ai" : "channel"} k={entry.ai_source ?? entry.channel} />{entry.ai_source ?? entry.channel}{entry.referrer_host ? ` · ${entry.referrer_host}` : ""}
                </span>
              )}
              {entry && (
                <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                  <ValueIcon dim="country" k={entry.country} />{entry.city ?? countryName(entry.country)} · {entry.browser} · {entry.os}
                </span>
              )}
            </div>
            <ul className="flex flex-col px-3 py-1.5">
              {v.events.map((e, i) => {
                const page = e.event === "$pageview";
                const Icon = page ? MousePointerClick : e.origin === "server" ? Server : Zap;
                const props = e.props && e.props !== "{}" ? Object.entries(JSON.parse(e.props)).map(([k, x]) => `${k}: ${x}`).join(" · ") : "";
                return (
                  <li key={i} className="flex items-center gap-2.5 py-1 text-sm">
                    <Icon className="size-3.5 shrink-0" style={{ color: page ? TONE.traffic : TONE.signup }} />
                    <span className={cn("min-w-0 truncate", page ? "font-mono text-[0.8125rem]" : "font-medium")}>{page ? `${e.host === entry?.host ? "" : e.host}${e.path}` : e.event}</span>
                    {props && <span className="min-w-0 truncate text-xs text-muted-foreground">{props}</span>}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{new Date(e.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

function PersonSheet({ me, open, tab, onClose }: { me: Me; open: string | null; tab: string; onClose: () => void }) {
  const [product, ...rest] = (open ?? "").split("/");
  const userId = rest.join("/");
  const { data, error } = useData<any>(open ? `/api/person/${product}/${encodeURIComponent(userId)}` : null);
  const p = data?.person;
  const ft = p?.first_touch ? JSON.parse(p.first_touch) : null;
  const productName = me.products.find((x) => x.id === product)?.name ?? product;
  const label = p?.name || p?.email || userId;
  return (
    <Sheet open={!!open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-3xl data-[side=right]:sm:border-l">
        <SheetHeader className="border-b pt-[max(1rem,env(safe-area-inset-top))] pr-14 sm:pr-12">
          <div className="flex items-center gap-3">
            <Avatar seed={userId} label={label} className="size-10 text-sm" />
            <div className="flex min-w-0 flex-col">
              <SheetTitle className="truncate">{label}</SheetTitle>
              <SheetDescription className="flex items-center gap-1.5">
                <ProductIcon id={product!} name={productName} className="size-4 rounded" />{productName}{p?.email && p?.name ? ` · ${p.email}` : ""}{p ? ` · signed up ${ago(p.created_at)}` : ""}
              </SheetDescription>
            </div>
          </div>
          {p && (
            <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
              {[["Revenue", money(p.ltv_cents, p.currency ?? "EUR"), TONE.money], ["Plan", p.plan ?? "Free", undefined], ["Last seen", ago(p.last_seen_at), undefined], ["Origin", ft?.ai_source ?? ft?.channel ?? "Unknown", ft?.ai_source ? TONE.ai : undefined]].map(([k, v, c]) => (
                <div key={k as string} className="flex flex-col bg-background px-3 py-2">
                  <span className="text-xs text-muted-foreground">{k}</span>
                  <span className="truncate text-sm font-semibold" style={c ? { color: c as string } : undefined}>{v}</span>
                </div>
              ))}
            </div>
          )}
          <Tabs value={tab} onValueChange={(v) => patchParams({ tab: v === "profile" ? null : String(v) })} className="-mx-4 mt-2 -mb-2 min-w-0 sm:mx-0">
            <TabsList variant="line" className="h-11 w-full justify-start overflow-x-auto px-4 [scrollbar-width:none] sm:h-9 sm:px-0 [&>*]:flex-none [&>*]:px-3 sm:[&>*]:px-1.5">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="replays">Replays{data ? ` · ${data.replays.length}` : ""}</TabsTrigger>
              <TabsTrigger value="payments">Payments{data ? ` · ${data.payments.length}` : ""}</TabsTrigger>
            </TabsList>
          </Tabs>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:p-6">
          <ErrorNote error={error} />
          {p && tab === "profile" && (
            <>
              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">Origin</h3>
                {ft ? (
                  <KV rows={[
                    ["Channel", <Source channel={ft.channel} ai={ft.ai_source} />],
                    ["Referrer", ft.referrer_host ? <span className="flex items-center gap-1.5"><ValueIcon dim="referrer" k={ft.referrer_host} />{ft.referrer_host}</span> : "–"],
                    ["Entry page", <span className="font-mono text-[0.8125rem]">{`${ft.host ?? ""}${ft.entry_path ?? ""}` || "–"}</span>],
                    ["UTM", [ft.utm_source, ft.utm_medium, ft.utm_campaign].filter(Boolean).join(" / ") || "–"],
                    ["Country", ft.country ? <span className="flex items-center gap-1.5"><ValueIcon dim="country" k={ft.country} />{countryName(ft.country)}</span> : "–"],
                    ["First visit", when(ft.at)],
                    ["Method", METHOD[p.attribution_method] ?? p.attribution_method],
                  ]} />
                ) : <p className="text-sm text-muted-foreground">Unknown origin: no visit linked before the sign-up.</p>}
              </section>
              <section className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">Account</h3>
                <KV rows={[
                  ["Email", p.email ?? "–"],
                  ["Signed up", when(p.created_at)],
                  ["ID", <span className="font-mono text-xs">{p.user_id}</span>],
                  ...(p.workspace_id ? [["Workspace", <span className="font-mono text-xs">{p.workspace_id}</span>] as [string, React.ReactNode]] : []),
                  ...(p.stripe_customer_id ? [["Stripe", <span className="font-mono text-xs">{p.stripe_customer_id}</span>] as [string, React.ReactNode]] : []),
                ]} />
              </section>
            </>
          )}
          {open && tab === "activity" && <ActivityTab product={product!} userId={userId} />}
          {p && tab === "replays" && (data.replays.length ? (
            <ul className="-mx-2 flex flex-col">
              {data.replays.map((r: any) => (
                <li key={r.id}>
                  <a href={href("/replays", { id: r.id, product })} className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted">
                    <PlayCircle className="size-5 shrink-0" style={{ color: TONE.traffic }} />
                    <span className="flex-1">{when(r.started_at)}</span>
                    <span className="text-muted-foreground tabular-nums">{duration(r.last_at - r.started_at)}</span>
                    <span className="w-20 text-right text-muted-foreground tabular-nums">{r.clicks} clicks</span>
                    {r.errors > 0 && <span className="text-down tabular-nums">{r.errors} errors</span>}
                  </a>
                </li>
              ))}
            </ul>
          ) : <p className="py-10 text-center text-sm text-muted-foreground">No replay in the last 30 days.</p>)}
          {p && tab === "payments" && (data.payments.length ? (
            <ul className="flex flex-col divide-y text-sm">
              {data.payments.map((x: any, i: number) => (
                <li key={x.id ?? i} className="flex items-center gap-3 py-2.5">
                  <CreditCard className="size-4 shrink-0" style={{ color: TONE.money }} />
                  <span className="flex-1">{when(x.created_at)}</span>
                  <span className="text-muted-foreground">{x.kind}</span>
                  <span className={cn("w-24 text-right font-medium tabular-nums", x.amount_cents < 0 && "text-down")}>{money(x.amount_cents, x.currency ?? "EUR")}</span>
                </li>
              ))}
            </ul>
          ) : <p className="py-10 text-center text-sm text-muted-foreground">No payment.</p>)}
          {!p && !error && <div className="flex flex-col gap-3">{Array.from({ length: 6 }, (_, i) => <span key={i} className="h-5 animate-pulse rounded bg-muted" style={{ width: `${80 - i * 8}%` }} />)}</div>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function PeopleScreen({ me }: { me: Me }) {
  const { params } = useRoute();
  const product = params.get("product") ?? "";
  const q = params.get("q") ?? "";
  const sort = params.get("sort") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => { const t = setTimeout(() => text !== q && patchParams({ q: text || null }), 250); return () => clearTimeout(t); }, [text]);
  const { data, error, current, reload } = useData<{ people: Person[] }>(`/api/people?product=${encodeURIComponent(product)}&q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}`);
  const open = params.get("open");
  const name = (id: string) => me.products.find((p) => p.id === id)?.name ?? id;
  const paying = data?.people.filter((p) => p.ltv_cents > 0).length ?? 0;
  const fromAi = data?.people.filter((p) => p.ai_source || p.channel === "AI").length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Users" meta={data ? `${num(data.people.length)}${data.people.length === 200 ? (sort ? " shown" : " most recent") : ""} · ${num(paying)} paying · ${num(fromAi)} from AI` : undefined}>
        <div className="relative max-sm:w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Email, name" aria-label="Search" className="h-10 pl-8 sm:h-8 sm:w-56" />
        </div>
        <Select value={product || "*"} onValueChange={(v) => patchParams({ product: v === "*" ? null : String(v) })}>
          <SelectTrigger aria-label="Product" className="h-10 max-sm:w-full sm:h-8 sm:min-w-40"><SelectValue>{(v: string) => (v === "*" ? "All products" : <span className="flex items-center gap-2"><ProductIcon id={v} name={name(v)} className="size-5 rounded-md" />{name(v)}</span>)}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="*">All products</SelectItem>
            {me.products.map((p) => <SelectItem key={p.id} value={p.id}><span className="flex items-center gap-2"><ProductIcon id={p.id} name={p.name} className="size-5 rounded-md" />{p.name}</span></SelectItem>)}
          </SelectContent>
        </Select>
      </PageHeader>
      <ErrorNote error={error} onRetry={reload} />
      <div className={`@container overflow-hidden rounded-xl border bg-background transition-opacity ${current ? "" : "opacity-60"}`}>
        {data && data.people.length === 0 ? (
          <p className="flex min-h-60 items-center justify-center px-6 text-center text-sm text-muted-foreground">{q || product ? "No one matches." : "Accounts created in the products show up here, with where they came from."}</p>
        ) : (
          <>
          <div className="flex items-center justify-between gap-3 border-b px-3 py-2 @xl:hidden">
            <span className="text-sm text-muted-foreground">Sort by</span>
            <Select value={sort || "newest"} onValueChange={(v) => patchParams({ sort: v === "newest" ? null : String(v) })}>
              <SelectTrigger aria-label="Sort" className="h-10 min-w-36"><SelectValue>{(v: string) => SORTS[v] ?? v}</SelectValue></SelectTrigger>
              <SelectContent>{Object.entries(SORTS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <ul className="flex flex-col divide-y @xl:hidden">
            {data ? data.people.map((p) => {
              const key = `${p.product}/${p.user_id}`;
              const label = p.name || p.email || p.user_id;
              return (
                <li key={key}>
                  <button type="button" onClick={() => patchParams({ open: key, tab: null })} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
                    <Avatar seed={p.user_id} label={label} className="size-10 text-sm" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-medium">{label}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <ProductIcon id={p.product} name={name(p.product)} className="size-4 shrink-0 rounded" />
                        <span className="truncate">{name(p.product)} · {p.ai_source ?? p.channel ?? "Unknown"}</span>
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground tabular-nums">
                      <span>{ago(p.last_seen_at ?? p.created_at)}</span>
                      {p.ltv_cents > 0 && <span className="font-medium" style={{ color: TONE.money }}>{money(p.ltv_cents, p.currency ?? "EUR")}</span>}
                    </span>
                  </button>
                </li>
              );
            }) : Array.from({ length: 6 }, (_, i) => <li key={i} className="px-4 py-3"><span className="block h-10 animate-pulse rounded bg-muted" /></li>)}
          </ul>
          <Table className="hidden table-fixed @xl:table">
            <TableHeader>
              <TableRow>
                <SortableHead label="User" sortKey="user" sort={sort} className="pl-4" />
                <SortableHead label="Product" sortKey="product" sort={sort} className="hidden w-36 @xl:table-cell" />
                <SortableHead label="Origin" sortKey="origin" sort={sort} className="w-52" />
                <SortableHead label="Country" sortKey="country" sort={sort} className="hidden w-16 @4xl:table-cell" />
                <SortableHead label="Plan" sortKey="plan" sort={sort} className="hidden w-24 @3xl:table-cell" />
                <TableHead className="hidden w-24 text-right @2xl:table-cell">Revenue</TableHead>
                <SortableHead label="Replays" sortKey="replays" sort={sort} className="hidden w-20 text-right @4xl:table-cell" />
                <SortableHead label="Last seen" sortKey="last_seen" sort={sort} className="w-32 pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data
                ? data.people.map((p) => {
                  const key = `${p.product}/${p.user_id}`;
                  const label = p.name || p.email || p.user_id;
                  return (
                    <TableRow key={key} className="cursor-pointer" onClick={() => patchParams({ open: key, tab: null })}>
                      <TableCell className="pl-4">
                        <span className="flex min-w-0 items-center gap-3">
                          <Avatar seed={p.user_id} label={label} />
                          <span className="flex min-w-0 flex-col">
                            <button type="button" className="truncate text-left font-medium outline-none focus-visible:underline" onClick={(e) => { e.stopPropagation(); patchParams({ open: key, tab: null }); }}>{label}</button>
                            <span className="truncate text-xs text-muted-foreground">{p.name && p.email ? p.email : `signed up ${ago(p.created_at)}`}</span>
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="hidden @xl:table-cell"><span className="flex min-w-0 items-center gap-2 text-muted-foreground"><ProductIcon id={p.product} name={name(p.product)} className="size-5 rounded-md" /><span className="truncate">{name(p.product)}</span></span></TableCell>
                      <TableCell className="truncate"><Source channel={p.channel} ai={p.ai_source} /></TableCell>
                      <TableCell className="hidden @4xl:table-cell">{p.country ? <span title={countryName(p.country)}><ValueIcon dim="country" k={p.country} /></span> : "–"}</TableCell>
                      <TableCell className="hidden truncate text-muted-foreground @3xl:table-cell">{p.plan ?? "–"}</TableCell>
                      <TableCell className="hidden text-right font-medium tabular-nums @2xl:table-cell" style={p.ltv_cents ? { color: TONE.money } : undefined}>{p.ltv_cents ? money(p.ltv_cents, p.currency ?? "EUR") : "–"}</TableCell>
                      <TableCell className="hidden text-right text-muted-foreground tabular-nums @4xl:table-cell">{p.replays || "–"}</TableCell>
                      <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">{ago(p.last_seen_at ?? p.created_at)}</TableCell>
                    </TableRow>
                  );
                })
                : Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}><TableCell colSpan={8} className="px-4"><span className="block h-8 animate-pulse rounded bg-muted" /></TableCell></TableRow>
                ))}
            </TableBody>
          </Table>
          </>
        )}
      </div>
      <PersonSheet me={me} open={open} tab={params.get("tab") ?? "profile"} onClose={() => patchParams({ open: null, tab: null })} />
    </div>
  );
}
