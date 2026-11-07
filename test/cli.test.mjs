import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { connectArchive, rows, tableSchemas } from "../cli/archive.mjs";
import { parseListing } from "../cli/r2-read.mjs";
import { gapLines, readReplay } from "../cli/replay-read.mjs";

describe("agent read tools", () => {
  it("queries typed empty archives with no credentials or network", async () => {
    const cache = mkdtempSync(join(tmpdir(), "csa-test-"));
    const root = resolve(import.meta.dirname, "..");
    const db = await connectArchive({ root, cache });
    try {
      expect(await rows(db, "SELECT count(*) AS n FROM events")).toEqual([{ n: 0n }]);
      expect(await rows(db, "SELECT id, user_id FROM replay_sessions")).toEqual([]);
      expect(tableSchemas(root).payments.some(([column]) => column === "amount_cents")).toBe(true);
    } finally { db.closeSync(); rmSync(cache, { recursive: true }); }
  });
  it("decodes listing entities and refuses broken pagination", () => {
    expect(parseListing('<IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken><Contents><Key>p/a&amp;b</Key><LastModified>2026-10-31T10:00:00Z</LastModified><Size>4</Size></Contents>').objects[0].key).toBe("p/a&b");
    expect(() => parseListing("<IsTruncated>true</IsTruncated>")).toThrow("cursor");
  });
  it("resumes validated replay chunks, reports holes and refuses corrupt chunks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "csa-replay-"));
    const meta = { id: "rs_abcdefghijklmnop", product: "p", day: "2026-10-30" };
    const prefix = `replays/p/${meta.day}/${meta.id}/`;
    const bytes = gzipSync(JSON.stringify([{ type: 4, timestamp: 1, data: { href: "https://p.test" } }]));
    let reads = 0;
    const reader = { list: async () => ({ objects: [{ key: `${prefix}0000.json.gz`, size: bytes.length, uploaded: new Date(0) }], truncated: false }), get: async () => { reads++; return { arrayBuffer: async () => bytes }; } };
    try {
      expect((await readReplay(reader, meta, directory)).events).toHaveLength(1);
      await readReplay(reader, meta, directory); expect(reads).toBe(1);
      const holed = await readReplay({ ...reader, list: async () => ({ objects: [0, 2].map((seq) => ({ key: `${prefix}000${seq}.json.gz`, size: bytes.length, uploaded: new Date(seq) })) }), get: async () => ({ arrayBuffer: async () => bytes }) }, meta, directory);
      expect(holed.events).toHaveLength(2);
      expect(holed.gaps).toEqual([{ seq: 1, after: 1 }]);
      expect(holed.manifest.missing_chunks).toEqual([1]);
      expect(gapLines(holed.gaps, 1)[0]).toMatchObject({ t: 1, kind: "gap" });
      const opening = await readReplay({ ...reader, list: async () => ({ objects: [{ key: `${prefix}0001.json.gz`, size: bytes.length, uploaded: new Date(9) }] }), get: async () => ({ arrayBuffer: async () => bytes }) }, meta, directory);
      expect(opening.gaps).toEqual([{ seq: 0, after: null }]);
      await expect(readReplay({ ...reader, list: async () => ({ objects: [{ key: `${prefix}x.json.gz`, size: 1, uploaded: new Date(0) }] }) }, meta, directory)).rejects.toThrow("unexpected");
      await expect(readReplay({ ...reader, list: async () => ({ objects: [{ key: `${prefix}0000.json.gz`, size: 3, uploaded: new Date(1) }] }), get: async () => ({ arrayBuffer: async () => Buffer.from("bad") }) }, meta, directory)).rejects.toThrow();
    } finally { rmSync(directory, { recursive: true }); }
  });
});
