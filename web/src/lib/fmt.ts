/* Display formats, in English (the dashboard's language since 2026-10-31). */
const nf = new Intl.NumberFormat("en-US");
export const num = (x: number | null | undefined) => nf.format(Math.round(x ?? 0));
export const compact = (x: number) => (Math.abs(x) >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : num(x));
export const money = (cents: number | null | undefined, currency = "EUR") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: Math.abs(cents ?? 0) < 10_000 ? 2 : 0 }).format((cents ?? 0) / 100);
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}` : "–");
export function duration(ms: number | null | undefined) {
  const s = Math.round((ms ?? 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const dayFmt = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLong = new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const dateTime = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const day = (iso: string) => dayFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
export const dayFull = (iso: string) => dayLong.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
export const when = (v: string | number | null | undefined) => (v ? dateTime.format(new Date(v)) : "–");
export function ago(v: string | number | null | undefined) {
  if (!v) return "–";
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return when(v);
}
/** Change against the previous period, in %, or null when there is nothing to compare with. */
export function change(now: number, before: number | null | undefined) {
  if (before === null || before === undefined || before === 0) return null;
  return Math.round(((now - before) / before) * 100);
}
