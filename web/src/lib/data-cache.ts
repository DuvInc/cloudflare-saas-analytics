import { api } from "./api";

type Entry = { data: unknown; at: number };
const seen = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();
const latest = new Map<string, symbol>();
let generation = 0;
export const cachedData = (path: string) => seen.get(path);
export function clearDataCache() { generation++; seen.clear(); pending.clear(); latest.clear(); }
if (typeof window !== "undefined") window.addEventListener("csa:signed-out", clearDataCache);

export async function loadData<T>(path: string, force = false): Promise<T> {
  const hit = seen.get(path);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit.data as T;
  const key = `${force ? "fresh:" : ""}${path}`;
  if (pending.has(key)) return pending.get(key) as Promise<T>;
  const current = generation;
  const ticket = Symbol(path);
  latest.set(path, ticket);
  const task = api<T>(path, force ? { headers: { "x-csa-refresh": "1" } } : undefined).then((data) => {
    if (current === generation && latest.get(path) === ticket) {
      seen.delete(path);
      seen.set(path, { data, at: Date.now() });
      if (seen.size > 80) seen.delete(seen.keys().next().value!);
    }
    return data;
  });
  pending.set(key, task);
  try { return await task; } finally {
    if (pending.get(key) === task) pending.delete(key);
    if (latest.get(path) === ticket) latest.delete(path);
  }
}
