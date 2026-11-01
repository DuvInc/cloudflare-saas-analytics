import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { api, type Me } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { money, when } from "@/lib/fmt";
import { navigate, useRoute } from "@/lib/route";
import { useData } from "@/lib/use-data";
import { PageHeader } from "@/components/shell";
import { PeriodControl, periodFrom } from "@/components/period";
import { ErrorNote } from "@/components/notes";
import { Source } from "@/components/source";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Payment = { id?: string; product: string; kind: string; item: string | null; email: string | null; user_id: string | null; amount_cents: number; currency: string | null; created_at: string; livemode: number; attribution: string | null };

export function PaymentsScreen({ me }: { me: Me }) {
  const { params } = useRoute();
  const days = periodFrom(params);
  const { data, error, current, reload } = useData<{ payments: Payment[] }>(`/api/payments?days=${days}`);
  const live = (data?.payments ?? []).filter((p) => p.livemode);
  const total = live.reduce((s, p) => s + p.amount_cents, 0);
  const name = (id: string) => me.products.find((p) => p.id === id)?.name ?? id;
  const [sync, setSync] = useState<string | null>(null);
  async function runSync() {
    setSync("Syncing…");
    const r = await api<{ results: string[] }>("/api/stripe/sync", { method: "POST", body: "{}" }).catch((e) => ({ results: [], error: (e as Error).message }));
    setSync("error" in r ? `Failed: ${r.error}` : r.results.length ? `Stripe up to date (${r.results.join(", ")} payments)` : "No Stripe account connected");
    reload();
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Payments" meta={sync ?? (data && live.length ? `${money(total)} from ${live.length} payments` : undefined)}>
        <Button variant="outline" onClick={runSync} disabled={sync === "Syncing…"}><RefreshCw data-icon="inline-start" className={sync === "Syncing…" ? "animate-spin" : undefined} />Sync Stripe</Button>
        <PeriodControl days={days} onChange={(d) => navigate("/payments", { days: d }, { replace: true })} />
      </PageHeader>
      <ErrorNote error={error} onRetry={reload} />
      <div className={`@container overflow-hidden rounded-xl border transition-opacity ${current ? "" : "opacity-60"}`}>
        {data && data.payments.length === 0 ? (
          <p className="flex min-h-60 items-center justify-center px-6 text-center text-sm text-muted-foreground">No payment in this period.</p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Customer</TableHead>
                <TableHead className="hidden w-28 @xl:table-cell">Product</TableHead>
                <TableHead className="hidden w-48 @2xl:table-cell">Origin</TableHead>
                <TableHead className="hidden w-28 @3xl:table-cell">Item</TableHead>
                <TableHead className="w-28 text-right">Amount</TableHead>
                <TableHead className="w-32 pr-4 text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data
                ? data.payments.map((p, i) => {
                  const a = p.attribution ? JSON.parse(p.attribution) : null;
                  return (
                    <TableRow key={p.id ?? i}>
                      <TableCell className="truncate pl-4 font-medium">{p.email ?? p.user_id ?? "–"} {!p.livemode && <Badge variant="outline" className="ml-1">test</Badge>}</TableCell>
                      <TableCell className="hidden truncate text-muted-foreground @xl:table-cell">{name(p.product)}</TableCell>
                      <TableCell className="hidden truncate @2xl:table-cell"><Source channel={a?.channel} ai={a?.ai_source} /></TableCell>
                      <TableCell className="hidden truncate text-muted-foreground @3xl:table-cell">{p.kind === "refund" ? "refund" : p.item ?? p.kind}</TableCell>
                      <TableCell className={`text-right tabular-nums ${p.amount_cents < 0 ? "text-destructive" : ""}`}>{money(p.amount_cents, p.currency ?? "EUR")}</TableCell>
                      <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">{when(p.created_at)}</TableCell>
                    </TableRow>
                  );
                })
                : Array.from({ length: 5 }, (_, i) => <TableRow key={i}><TableCell colSpan={6} className="px-4"><span className="block h-5 animate-pulse rounded bg-muted" /></TableCell></TableRow>)}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
