import { gzipSync } from "node:zlib";

/* A minimal R2 + D1 double: enough to run the real rollup on gzip NDJSON files. */
export function fakeEnv(raw: Record<string, { body: string; uploaded: number }>, manifests: { key: string; ran_at: string; files: string }[] = []) {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  for (const [k, v] of Object.entries(raw)) {
    /* Like Basin: one gzip member per line, concatenated. */
    const members = v.body.split("\n").map((l) => gzipSync(l + "\n"));
    objects.set(k, { bytes: new Uint8Array(Buffer.concat(members)), uploaded: new Date(v.uploaded) });
  }
  const statements: { sql: string; args: unknown[] }[] = [];
  const stmt = (sql: string) => {
    const s = { sql, args: [] as unknown[], bind(...a: unknown[]) { s.args = a; return s; },
      async all() { statements.push(s); return { results: sql.includes("SELECT key, ran_at, files FROM runs") ? manifests : [] }; }, async first() { statements.push(s); return null; }, async run() { statements.push(s); return { meta: { changes: 1 } }; } };
    return s;
  };
  const bucket = {
    async list({ prefix }: { prefix: string }) {
      return { objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })), truncated: false };
    },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { body: new Blob([o.bytes]).stream(), arrayBuffer: async () => o.bytes.slice().buffer, json: async () => JSON.parse(new TextDecoder().decode(o.bytes)), httpMetadata: {}, text: async () => new TextDecoder().decode(o.bytes) } : null;
    },
    async put(key: string, body: ArrayBuffer | string) { objects.set(key, { bytes: typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body), uploaded: new Date() }); },
    async delete(keys: string[] | string) { for (const k of [keys].flat()) objects.delete(k); },
  };
  const db = { prepare: stmt, async batch(list: unknown[]) { statements.push(...(list as never[])); return []; } };
  return { env: { BUCKET: bucket, DB: db } as never, objects, statements };
}
