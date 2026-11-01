import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const PERIODS = [
  { days: 1, label: "Today", short: "1d" },
  { days: 7, label: "7 days", short: "7d" },
  { days: 30, label: "30 days", short: "30d" },
  { days: 90, label: "90 days", short: "90d" },
  { days: 365, label: "12 months", short: "12m" },
] as const;

export function periodFrom(params: URLSearchParams) {
  const d = Number(params.get("days") ?? localStorage.getItem("csa_days") ?? 30);
  return PERIODS.some((p) => p.days === d) ? d : 30;
}

/** A few exclusive values side by side: the segmented control. */
export function PeriodControl({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <ToggleGroup
      variant="segmented"
      value={[String(days)]}
      onValueChange={(v: string[]) => { const d = Number(v[0]); if (d) { localStorage.setItem("csa_days", String(d)); onChange(d); } }}
      aria-label="Period"
    >
      {PERIODS.map((p) => (
        <ToggleGroupItem key={p.days} value={String(p.days)} className="px-2.5 text-[0.8125rem]">
          <span className="hidden sm:inline">{p.label}</span>
          <span className="sm:hidden">{p.short}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
