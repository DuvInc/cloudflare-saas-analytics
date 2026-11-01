/**
 * The path of a sparkline: a smooth line with no axes, drawn in a small box
 * from a series of numbers. Pure, so the shapes are tested without a browser.
 *
 * Counts start from zero (a trend of 100, 102, 98 looks flat, which is the
 * truth), a `null` is a day without data and breaks the line, and a series
 * that is all zero is flat on the baseline.
 *
 * Smooth: a long series is lightly averaged with its neighbours (jitter from
 * day to day is not the trend), then joined by a monotone cubic curve
 * (Fritsch-Carlson), which never overshoots: the line cannot dip below zero or
 * rise above the peak between two points.
 */

export type SparklineShape = {
  /** SVG path data of the line; one subpath per run of known values. */
  d: string;
  /** The same runs closed down to the baseline, for a faint fill under the line. */
  area: string;
  /** Every known value is zero: drawn quieter, on the baseline. */
  flat: boolean;
};

const round = (n: number) => Math.round(n * 10) / 10;
type Point = { x: number; y: number };

/** [1, 2, 1] / 4 inside a run; the ends stay where they are. */
function soften(values: number[]): number[] {
  if (values.length < 6) return values;
  return values.map((v, i) => (i === 0 || i === values.length - 1 ? v : (values[i - 1] + 2 * v + values[i + 1]) / 4));
}

/** The cubic segments of a monotone curve through the points (Fritsch-Carlson tangents). */
function monotone(points: Point[]): string {
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    slope.push((points[i + 1].y - points[i].y) / dx[i]);
  }
  const m: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = "";
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${round(points[i].x + h)} ${round(points[i].y + m[i] * h)} ${round(points[i + 1].x - h)} ${round(points[i + 1].y - m[i + 1] * h)} ${round(points[i + 1].x)} ${round(points[i + 1].y)}`;
  }
  return d;
}

/** At least two entries are needed to draw a line; otherwise there is nothing to say. */
export function sparklinePath(series: readonly (number | null)[] | undefined, width: number, height: number, pad = 2): SparklineShape | null {
  if (!series || series.length < 2) return null;
  const known = series.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return null;
  const max = Math.max(...known, 0);
  const flat = max <= 0;
  const stepX = (width - pad * 2) / (series.length - 1);
  const top = pad;
  const bottom = height - pad;

  // Runs of known values, each with its x positions.
  const runs: { x: number; v: number }[][] = [];
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      runs.push([]);
      return;
    }
    if (runs.length === 0) runs.push([]);
    runs[runs.length - 1].push({ x: pad + i * stepX, v });
  });

  let d = "";
  let area = "";
  for (const run of runs) {
    if (run.length === 0) continue;
    const values = soften(run.map((r) => Math.max(r.v, 0)));
    // Softening cannot raise the peak above the scale; the scale is the raw peak.
    const points = run.map((r, i) => ({ x: r.x, y: flat ? bottom : bottom - (values[i] / max) * (bottom - top) }));
    const start = `M${round(points[0].x)} ${round(points[0].y)}`;
    // A lone known value between gaps is a dot, not a line.
    const line = points.length === 1 ? `L${round(points[0].x)} ${round(points[0].y)}` : monotone(points);
    d += start + line;
    if (points.length > 1 && !flat) area += `${start}${line}L${round(points[points.length - 1].x)} ${round(bottom)}L${round(points[0].x)} ${round(bottom)}Z`;
  }
  return { d, area, flat };
}
