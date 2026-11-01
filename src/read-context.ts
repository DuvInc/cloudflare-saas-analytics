import type { Env } from "./env";
import type { Raw } from "./aggregate";
import { readLines } from "./rollup";
import { pool } from "./pool";

type Entry = { value: unknown; expires: number; weight: number };
type Manifest = { key: string; ran_at: string; files: string };
const TTL = 120_000;
const BUDGET = 16 * 1024 * 1024;
const stores = new WeakMap<object, Map<string, Entry>>();
const tickets = new WeakMap<object, Map<string, symbol>>();

export class ReadContext {
  private pending = new Map<string, Promise<unknown>>();
  private store: Map<string, Entry>;
  private latest: Map<string, symbol>;
  private ledger?: Promise<Map<string, Manifest>>;
  private raw?: Promise<R2Object[]>;
  private refreshed = new Set<string>();
  private deadline = Infinity;

  constructor(readonly env: Env, readonly fresh = false) {
    let store = stores.get(env.BUCKET);
    if (!store) stores.set(env.BUCKET, store = new Map());
    this.store = store;
    let latest = tickets.get(env.BUCKET);
    if (!latest) tickets.set(env.BUCKET, latest = new Map());
    this.latest = latest;
  }

  async cached<T>(key: string, load: () => Promise<T>, weight: (value: T) => number = () => 1024): Promise<T> {
    const hit = this.store.get(key);
    if ((!this.fresh || this.refreshed.has(key)) && hit && hit.expires > Date.now()) {
      this.deadline = Math.min(this.deadline, hit.expires);
      this.store.delete(key);
      this.store.set(key, hit);
      return hit.value as T;
    }
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const ticket = Symbol(key);
    this.latest.set(key, ticket);
    const started = Date.now();
    const task = load().then((value) => {
      if (this.latest.get(key) !== ticket) return value;
      this.store.delete(key);
      for (const [name, entry] of this.store) if (entry.expires <= Date.now()) this.store.delete(name);
      const size = weight(value);
      if (size <= BUDGET) {
        let used = [...this.store.values()].reduce((total, entry) => total + entry.weight, 0);
        while (this.store.size && (used + size > BUDGET || this.store.size >= 2000)) {
          const oldest = this.store.keys().next().value!;
          used -= this.store.get(oldest)!.weight;
          this.store.delete(oldest);
        }
        const expires = Math.min(started + TTL, this.deadline);
        this.store.set(key, { value, expires, weight: size });
        this.deadline = Math.min(this.deadline, expires);
      }
      this.refreshed.add(key);
      return value;
    });
    this.pending.set(key, task);
    try { return await task; } finally {
      this.pending.delete(key);
      if (this.latest.get(key) === ticket) this.latest.delete(key);
    }
  }

  manifests() {
    return this.ledger ??= this.env.DB.prepare("SELECT key, ran_at, files FROM runs WHERE job = 'rollup' AND status = 'ok'")
      .all<Manifest>().then((result) => new Map((result.results ?? []).map((row) => [row.key, row])));
  }

  private files() {
    return this.raw ??= this.cached("raw:list", async () => {
      const objects: R2Object[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.env.BUCKET.list({ prefix: "raw/", cursor, limit: 1000 });
        objects.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return objects;
    }, (objects) => objects.length * 512);
  }

  private hourCompactions(today: string) {
    return this.cached(`hours:list:${today}`, async () => {
      const page = await this.env.BUCKET.list({ prefix: `cache/hours/${today}/`, limit: 100 });
      return new Set(page.objects.map((o) => o.key));
    }, () => 1024);
  }

  private async fileRaw(key: string, version = "open"): Promise<readonly Raw[]> {
    return this.cached(`file:${key}:${version}`, () => readLines(this.env, key), (rows) => rows.length * 512 + 512);
  }

  /** Read-only view of a day's events (no per-event shallow clone; safe for funnels and activity). */
  async dayReadOnly(day: string, today: string): Promise<readonly Raw[]> {
    const from = Date.parse(`${day}T00:00:00Z`);
    if (day !== today) {
      const manifest = (await this.manifests()).get(day);
      if (manifest) {
        const keys = JSON.parse(manifest.files) as string[];
        if (!keys.length) return [];
        return (await pool(keys, 6, (key) => this.fileRaw(key, manifest.ran_at))).flat();
      }
      const parts: R2Object[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.env.BUCKET.list({ prefix: `daily/${day}/`, cursor, limit: 1000 });
        parts.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      if (parts.length) return (await pool(parts, 6, (part) => this.fileRaw(part.key))).flat();
    }
    const to = Math.min(from + 86400_000, Date.now() + 1);
    let contiguousHours = 0;
    const hourKeys: string[] = [];
    if (day === today) {
      const available = await this.hourCompactions(today);
      while (contiguousHours < 24) {
        const k = `cache/hours/${today}/${String(contiguousHours).padStart(2, "0")}.ndjson.gz`;
        if (!available.has(k)) break;
        hourKeys.push(k);
        contiguousHours++;
      }
    }
    const watermark = from + contiguousHours * 3600_000;
    const [compactedParts, rawObjects] = await Promise.all([
      hourKeys.length ? pool(hourKeys, 6, (k) => this.fileRaw(k, "hour")) : Promise.resolve([] as (readonly Raw[])[]),
      this.files(),
    ]);
    const tailFiles = rawObjects.filter((file) => file.uploaded.getTime() >= watermark - 3600_000 && file.uploaded.getTime() <= to + 30 * 60_000);
    const tailParts = await pool(tailFiles, 6, (file) => this.fileRaw(file.key));
    const tailEvents = tailParts.flat().filter((event) => typeof event.received_at === "number" && event.received_at >= watermark && event.received_at < to);
    return hourKeys.length ? [...compactedParts.flat(), ...tailEvents] : tailEvents;
  }

  /** Mutable copy of a day's events (safe for sessionize() which sets visit_id in place). */
  async day(day: string, today: string): Promise<Raw[]> {
    const events = await this.dayReadOnly(day, today);
    return events.map((event) => ({ ...event }));
  }
}
