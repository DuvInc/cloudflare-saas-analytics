import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { syncCompactedDay } from "../cli/compact-sync.mjs";

describe("CLI compacted day sync", () => {
  it("converts mixed gzip and Brotli manifests into one exact local Parquet", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "compact-sync-"));
    const instance = await DuckDBInstance.create(":memory:");
    const db = await instance.connect();
    try {
      const files = ["daily/old.gz", "daily/product=two/new.br"];
      const payloads = [gzipSync('{"product":"one","event":"été","received_at":1}\n'), brotliCompressSync(Buffer.from('{"product":"two","event":"東京","received_at":2}'))];
      const reader = { async get(key) { const index = files.indexOf(key); return index < 0 ? null : { arrayBuffer: async () => payloads[index] }; } };
      const out = path.join(directory, "day.parquet");
      await syncCompactedDay(db, reader, files, out, "{product:'VARCHAR',event:'VARCHAR',received_at:'BIGINT'}");
      const rows = (await db.runAndReadAll(`SELECT product,event,received_at FROM read_parquet('${out}') ORDER BY product`)).getRowObjects();
      expect(rows).toEqual([{ product: "one", event: "été", received_at: 1n }, { product: "two", event: "東京", received_at: 2n }]);
      expect(readdirSync(directory)).toEqual(["day.parquet"]);
    } finally { db.closeSync(); instance.closeSync(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves the prior archive and cleans staging when a part is missing", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "compact-sync-"));
    const out = path.join(directory, "day.parquet");
    writeFileSync(out, "previous archive");
    try {
      await expect(syncCompactedDay({}, { get: async () => null }, ["missing.br"], out, "{}")).rejects.toThrow("Missing compacted object");
      expect(readFileSync(out, "utf8")).toBe("previous archive");
      expect(readdirSync(directory)).toEqual(["day.parquet"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
