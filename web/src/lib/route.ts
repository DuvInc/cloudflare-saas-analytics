/*
  Where you are lives in the address (design system, "Navigation and the address"): the screen in
  the hash path, its filters, period and open row in the hash query. Inside a screen, replace;
  between screens, push, so Back returns to the screen as it was.
*/
import { useSyncExternalStore } from "react";

const read = () => {
  const [path = "/", query = ""] = location.hash.replace(/^#/, "").split("?");
  return { path: path || "/", query };
};
let snapshot = read();
const listeners = new Set<() => void>();
const update = () => { snapshot = read(); listeners.forEach((l) => l()); };
window.addEventListener("hashchange", update);
window.addEventListener("popstate", update);

export function useRoute() {
  const r = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot);
  return { path: r.path, params: new URLSearchParams(r.query) };
}

export function href(path: string, params?: Record<string, string | number | null | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

export function navigate(path: string, params?: Record<string, string | number | null | undefined>, opts: { replace?: boolean } = {}) {
  const next = href(path, params);
  if (opts.replace) { history.replaceState(null, "", next); snapshot = read(); listeners.forEach((l) => l()); }
  else location.hash = next;
}

/** One navigation for several keys of the current screen (two in a row would undo each other). */
export function patchParams(patch: Record<string, string | number | null | undefined>) {
  const { path, query } = read();
  const q = Object.fromEntries(new URLSearchParams(query));
  navigate(path, { ...q, ...patch }, { replace: true });
}
