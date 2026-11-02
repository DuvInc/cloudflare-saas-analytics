import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const quote = value => `'${String(value).replaceAll("'", "''")}'`;

export async function syncCompactedDay(db, reader, files, out, columns) {
  const staging = mkdtempSync(path.join(path.dirname(out), ".sync-"));
  try {
    const inputs = files.map((key, index) => path.join(staging, `${index}.ndjson`));
    let next = 0;
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(files.length, 6) }, async () => {
      while (next < files.length) {
        const index = next++;
        const key = files[index];
        const object = await reader.get(key);
        if (!object) throw new Error(`Missing compacted object: ${key}`);
        const bytes = new Uint8Array(await object.arrayBuffer());
        const text = (key.endsWith(".br") ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toString("utf8");
        writeFileSync(inputs[index], text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
      }
    }));
    const failed = downloads.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    const parquet = path.join(staging, "events.parquet");
    await db.run(`COPY (SELECT * FROM read_json([${inputs.map(quote).join(",")}], format = 'newline_delimited', columns = ${columns})) TO ${quote(parquet)} (FORMAT parquet, COMPRESSION zstd)`);
    chmodSync(parquet, 0o600);
    renameSync(parquet, out);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
