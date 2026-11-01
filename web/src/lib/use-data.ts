/*
  A screen's data, keyed by its request. A request already answered in this tab shows at once from
  memory and is refreshed behind it; while a new key loads, the last answer stays on screen (dimmed
  by the caller through `current`), so a period or filter change never blanks the page.
*/
import { useEffect, useRef, useState } from "react";
import { Unauthenticated } from "@/lib/api";
import { cachedData, loadData } from "@/lib/data-cache";

export function useData<T = any>(path: string | null) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>(() =>
    path && cachedData(path) ? { key: path, data: cachedData(path)!.data as T, error: null } : { key: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const lastTick = useRef(0);
  useEffect(() => {
    if (!path) return;
    const id = ++seq.current;
    const hit = cachedData(path);
    if (hit) setState({ key: path, data: hit.data as T, error: null });
    const force = lastTick.current !== tick;
    lastTick.current = tick;
    loadData<T>(path, force)
      .then((data) => { if (id === seq.current) setState({ key: path, data, error: null }); })
      .catch((e) => { if (id === seq.current && !(e instanceof Unauthenticated)) setState((s) => ({ ...s, key: path, error: (e as Error).message })); });
    return () => { seq.current++; };
  }, [path, tick]);
  return { data: state.data, error: state.error, current: state.key === path, reload: () => setTick((t) => t + 1) };
}
