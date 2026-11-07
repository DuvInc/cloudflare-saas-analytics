/* Is the pipeline healthy: open issues, access & devices (passkeys, sessions, enrolment), and the last jobs. */
import { AlertTriangle, Check, CheckCircle2, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { ago } from "@/lib/fmt";
import { useData } from "@/lib/use-data";
import { PageHeader } from "@/components/shell";
import { ErrorNote } from "@/components/notes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Run = { job: string; key: string; status: string; note: string | null; ran_at: string };
type PasskeyRow = { id: string; label: string; created_at: string; last_used_at: string | null };
type SessionRow = { id: string; label: string; created_at: string; last_seen_at: string };
type DevicesPayload = { current: string | null; passkeys: PasskeyRow[]; sessions: SessionRow[] };

const JOB: Record<string, string> = {
  rollup: "Daily rollup",
  compact_hours: "Hourly cache",
  bots: "AI & bots crawl",
  bots_day: "AI & bots rollup",
  bots_delivery: "AI delivery",
  stripe_reconcile: "Stripe",
  stripe_backfill: "Stripe history",
  report: "Report",
  prune: "Retention cleanup",
};

function DevicesPanel() {
  const { data, error, reload } = useData<DevicesPayload>("/api/auth/devices");
  const [enrollUrl, setEnrollUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  async function createInvite() {
    setBusy("enroll");
    setActionError("");
    try {
      const res = await api<{ url: string }>("/api/auth/enroll", { method: "POST", body: "{}" });
      setEnrollUrl(res.url);
      setCopied(false);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copyInvite() {
    if (!enrollUrl) return;
    await navigator.clipboard.writeText(enrollUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function revokeSession(id: string, isCurrent: boolean) {
    setBusy(id);
    setActionError("");
    try {
      if (isCurrent) {
        await api("/api/auth/logout", { method: "POST", body: "{}" });
        window.dispatchEvent(new Event("csa:signed-out"));
        return;
      }
      await api(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removePasskey(id: string) {
    setBusy(id);
    setActionError("");
    try {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Access & devices</h2>
          <p className="text-xs text-muted-foreground">Passkeys registered for operator sign-in and active browser sessions.</p>
        </div>
        <Button size="sm" variant="outline" onClick={createInvite} disabled={busy === "enroll"}>
          <Plus data-icon="inline-start" />Add device
        </Button>
      </div>
      <ErrorNote error={error || actionError} onRetry={reload} />
      {enrollUrl && (
        <div className="flex flex-col gap-2 rounded-xl border bg-background p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-foreground">One-time enrolment link (valid 15 minutes)</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{enrollUrl}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={copyInvite}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border bg-background">
          <div className="border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">Passkeys</div>
          <Table>
            <TableBody>
              {data ? (
                data.passkeys.map((pk) => {
                  const onlyOne = data.passkeys.length <= 1;
                  return (
                    <TableRow key={pk.id}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-2 font-medium">
                          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{pk.label}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {pk.last_used_at ? `Used ${ago(pk.last_used_at)}` : `Added ${ago(pk.created_at)}`}
                        </div>
                      </TableCell>
                      <TableCell className="w-24 pr-4 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={onlyOne || busy === pk.id}
                          title={onlyOne ? "Add another device before removing the last passkey" : "Remove passkey and revoke its sessions"}
                          onClick={() => removePasskey(pk.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow><TableCell className="px-4"><span className="block h-5 animate-pulse rounded bg-muted" /></TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="overflow-hidden rounded-xl border bg-background">
          <div className="border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">Active sessions</div>
          <Table>
            <TableBody>
              {data ? (
                data.sessions.map((s) => {
                  const isCurrent = s.id === data.current;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-2 font-medium">
                          <span className="truncate">{s.label}</span>
                          {isCurrent && <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">This device</span>}
                        </div>
                        <div className="text-xs text-muted-foreground">Active {ago(s.last_seen_at)}</div>
                      </TableCell>
                      <TableCell className="w-24 pr-4 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === s.id}
                          onClick={() => revokeSession(s.id, isCurrent)}
                        >
                          {isCurrent ? "Sign out" : "Revoke"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow><TableCell className="px-4"><span className="block h-5 animate-pulse rounded bg-muted" /></TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  );
}

export function HealthScreen() {
  const { data, error, reload } = useData<{ issues: { id: string; message: string }[]; runs: Run[] }>("/api/health");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Health" meta="Reports reach Slack #analytics every morning" />
      <ErrorNote error={error} onRetry={reload} />
      {data && (data.issues.length ? (
        <div className="flex flex-col gap-2">
          {data.issues.map((i) => (
            <Alert key={i.id} variant="warning"><AlertTriangle aria-hidden="true" /><AlertDescription>{i.message}</AlertDescription></Alert>
          ))}
        </div>
      ) : (
        <Alert variant="success"><CheckCircle2 aria-hidden="true" /><AlertTitle>All running</AlertTitle><AlertDescription>Collection, rollups and Stripe without errors in the last 10 days.</AlertDescription></Alert>
      ))}
      <DevicesPanel />
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight">Recent jobs</h2>
        <div className="@container overflow-hidden rounded-xl border bg-background">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-32 pl-4 @md:w-40">Job</TableHead>
                <TableHead className="hidden w-32 @md:table-cell">Key</TableHead>
                <TableHead className="w-20 @md:w-24">Status</TableHead>
                <TableHead className="hidden @2xl:table-cell">Note</TableHead>
                <TableHead className="w-24 pr-4 text-right @md:w-32">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data
                ? data.runs.map((r) => (
                  <TableRow key={`${r.job}${r.key}${r.ran_at}`}>
                    <TableCell className="truncate pl-4">{JOB[r.job] ?? r.job}</TableCell>
                    <TableCell className="hidden truncate tabular-nums text-muted-foreground @md:table-cell">{r.key}</TableCell>
                    <TableCell className={r.status === "ok" ? "text-up" : "text-down"}>{r.status === "ok" ? "OK" : "Failed"}</TableCell>
                    <TableCell className="hidden truncate text-muted-foreground @2xl:table-cell" title={r.note ?? ""}>{r.note}</TableCell>
                    <TableCell className="pr-4 text-right text-muted-foreground">{ago(r.ran_at)}</TableCell>
                  </TableRow>
                ))
                : Array.from({ length: 5 }, (_, i) => <TableRow key={i}><TableCell colSpan={5} className="px-4"><span className="block h-5 animate-pulse rounded bg-muted" /></TableCell></TableRow>)}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
