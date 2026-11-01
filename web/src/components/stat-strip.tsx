import { Hint } from "@/components/ui/help-tooltip";
import { sparklinePath } from "@/lib/sparkline";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "good" | "bad" | "warn" | "muted";

export type StatItem = {
  /** Short, one line: a long label is shortened or explained by `hint`. */
  label: string;
  /** Already formatted for the screen. */
  value: string;
  /** After the number, in the label's colour: `s`, `ms`. */
  unit?: string;
  /** After the unit: `of 125,000`, `62% positive`. */
  suffix?: string;
  /** How the figure moved over the period, oldest first; `null` is a day without data. No curve under two points. */
  series?: readonly (number | null)[];
  /** A capacity: a thin line of how much is used replaces the curve. */
  progress?: { value: number; max: number };
  /** The explanation of the label, on hover and focus. */
  hint?: string;
  tone?: StatTone;
};

const SPARK = { width: 56, height: 20 } as const;

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-foreground",
  good: "text-success-foreground",
  bad: "text-destructive",
  warn: "text-warning-foreground",
  muted: "text-muted-foreground",
};

/**
 * The columns once the strip has the room, by how many segments it has: a
 * segment needs about 150px. Below that, two columns inside the same pill,
 * where an odd last segment takes the whole row so no cell stays empty. The
 * classes are written out so Tailwind finds them.
 */
const LAST = "[&>*:last-child:nth-child(odd)]:col-span-2";
const WIDE: Record<number, string> = {
  1: LAST,
  2: `@lg:grid-cols-2 ${LAST}`,
  3: `@2xl:grid-cols-3 ${LAST} @2xl:[&>*:last-child:nth-child(odd)]:col-span-1`,
  4: "@2xl:grid-cols-4",
  5: `@4xl:grid-cols-5 ${LAST} @4xl:[&>*:last-child:nth-child(odd)]:col-span-1`,
  6: "@4xl:grid-cols-6",
};
const columns = (n: number) => cn("grid grid-cols-2 gap-px", WIDE[Math.min(Math.max(n, 1), 6)]);

export function Sparkline({ series, tone = "default", className }: { series?: readonly (number | null)[]; tone?: StatTone; className?: string }) {
  const shape = sparklinePath(series, SPARK.width, SPARK.height);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
      className={cn("ml-auto h-5 w-14 shrink-0 overflow-visible", className)}
    >
      {shape && (
        <g className={cn(tone === "bad" ? "text-destructive" : "text-muted-foreground", shape.flat && "opacity-40")}>
          {/* A whisper of fill under the line, so the curve has weight without shouting. */}
          {shape.area && <path d={shape.area} fill="currentColor" fillOpacity={0.09} stroke="none" />}
          <path d={shape.d} fill="none" stroke="currentColor" strokeOpacity={0.75} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}

export function Capacity({ value, max, tone, className }: { value: number; max: number; tone: StatTone; className?: string }) {
  const share = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  return (
    <span aria-hidden="true" className={cn("ml-auto block h-1 w-14 shrink-0 overflow-hidden rounded-full bg-border", className)}>
      <span
        className={cn("block h-full rounded-full", tone === "warn" ? "bg-warning-border" : tone === "bad" ? "bg-destructive" : "bg-foreground/60")}
        style={{ width: `${Math.max(share * 100, value > 0 ? 4 : 0)}%` }}
      />
    </span>
  );
}

/** A figure's label, with its explanation on hover when it has one. Shared by the strip and the rail. */
export function FigureLabel({ item }: { item: StatItem }) {
  return (
    <dt className="truncate text-xs leading-5 text-muted-foreground">
      {item.hint ? <Hint content={item.hint}>{item.label}</Hint> : item.label}
    </dt>
  );
}

/** A figure's number, unit and suffix. Shared by the strip and the rail. */
export function FigureNumber({ item }: { item: StatItem }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1 whitespace-nowrap">
      <span className={cn("text-lg leading-6 font-semibold tabular-nums", VALUE_TONE[item.tone ?? "default"])}>{item.value}</span>
      {item.unit && <span className="text-sm text-muted-foreground">{item.unit}</span>}
      {item.suffix && <span className="text-sm text-muted-foreground">{item.suffix}</span>}
    </span>
  );
}

function Segment({ item }: { item: StatItem }) {
  const tone = item.tone ?? "default";
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-background px-3 py-2 @lg:px-4">
      <FigureLabel item={item} />
      <dd className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <FigureNumber item={item} />
        {item.progress ? <Capacity {...item.progress} tone={tone} /> : item.series ? <Sparkline series={item.series} tone={tone} /> : null}
      </dd>
    </div>
  );
}

function SkeletonSegment() {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 bg-background px-3 py-2 @lg:px-4">
      <span className="h-4 w-16 animate-pulse rounded-sm bg-border" />
      <span className="h-6 w-20 animate-pulse rounded-sm bg-border" />
    </div>
  );
}

/**
 * The figures of a screen as one long pill: a bordered container with a plain
 * background, one segment per figure (a short label, the number, and either a
 * curve of how it moved or a thin line of how much of a capacity is used),
 * thin dividers between them. About 60px high on a wide screen; on a narrow
 * one the segments wrap to two columns inside the same pill.
 *
 * `items` null is the first read: the same pill, with its segments empty, so
 * nothing jumps when the figures arrive. `current` false dims the figures
 * kept on screen while the server recomputes them for new filters. The group
 * is a polite live region and each segment is read "label, value".
 */
export function StatStrip({
  items,
  current = true,
  label,
  placeholders = 4,
  className,
}: {
  items: readonly StatItem[] | null;
  current?: boolean;
  /** Names the group for screen readers: "Conversation figures". */
  label: string;
  /** Segments of the pill while `items` is null. */
  placeholders?: number;
  className?: string;
}) {
  const n = items ? items.length : placeholders;
  return (
    <div className={cn("@container", className)}>
      <div
        role="group"
        aria-label={label}
        aria-live="polite"
        aria-busy={items === null || !current}
        data-slot="stat-strip"
        className={cn("overflow-hidden rounded-lg border bg-border transition-opacity", !current && "opacity-60")}
      >
        {items ? (
          <dl className={columns(n)}>
            {items.map((item) => (
              <Segment key={item.label} item={item} />
            ))}
          </dl>
        ) : (
          <div className={columns(n)}>
            {Array.from({ length: n }, (_, i) => (
              <SkeletonSegment key={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
