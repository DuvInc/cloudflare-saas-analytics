/**
 * Display formatting. Everything here is pure and locale-explicit.
 *
 * WHY `locale` IS ALWAYS A PARAMETER AND NEVER AMBIENT. Client components are
 * pre-rendered on the Worker before they hydrate in the browser. Calling
 * `toLocaleString()` with no argument uses the ambient locale, which is the
 * Worker's on one side and the visitor's on the other — so the same number
 * renders as `2,000` server-side and `2 000` in a French browser, React sees a
 * mismatch, and it throws the whole page away (hydration error #418). Passing
 * the app locale explicitly is what makes both sides agree.
 */

const numberFormatters = new Map<string, Intl.NumberFormat>();

export function formatNumber(n: number, locale: string): string {
  let formatter = numberFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale);
    numberFormatters.set(locale, formatter);
  }
  return formatter.format(n);
}

/** `1.2k`, `3M`. For a chip where the exact figure is not the point. */
export function formatCreditsCompact(n: number, locale: string): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return formatNumber(n, locale);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Uploads are stored as `<uuid>-<original name>` so two files with the same
 * name cannot collide in object storage. The id is plumbing; only the name the
 * customer recognises is ever shown.
 */
const MINTED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

export function stripMintedId(name: string): string {
  return name.match(MINTED_ID)?.[1] ?? name;
}

export function filenameFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return stripMintedId(path.split("/").pop() ?? path);
}

export function splitFilename(filename: string): { base: string; extension: string } {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0) return { base: trimmed, extension: "" };
  return { base: trimmed.slice(0, lastDot), extension: trimmed.slice(lastDot) };
}

/** Appends `_1`, `_2`… until the name is free. Used when two uploads collide. */
export function uniqueFilename(filename: string, existingNames: Set<string>): string {
  const safeName = filename.trim().replace(/[\\/]/g, "_").replace(/\0/g, "");
  const { base, extension } = splitFilename(safeName);
  const rootName = base || "file";
  const initial = `${rootName}${extension}`;
  if (!existingNames.has(initial)) return initial;

  let counter = 1;
  while (existingNames.has(`${rootName}_${counter}${extension}`)) counter += 1;
  return `${rootName}_${counter}${extension}`;
}
