import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function writePrivate(file, value) {
  writeFileSync(`${file}.pending`, value, { mode: 0o600 });
  renameSync(`${file}.pending`, file);
}
export async function readReplay(reader, meta, directory, { maxBytes = 64 * 1024 * 1024, maxChunks = 720 } = {}) {
  if (!/^rs_[A-Za-z0-9]{16,32}$/.test(meta.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(meta.product) || !/^\d{4}-\d{2}-\d{2}$/.test(meta.day)) throw new Error("Invalid replay identity");
  const prefix = `replays/${meta.product}/${meta.day}/${meta.id}/`;
  const objects = [];
  let cursor;
  do {
    const page = await reader.list({ prefix, cursor });
    objects.push(...page.objects);
    if (objects.length > maxChunks) throw new Error("Replay chunk cap exceeded");
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  objects.sort((left, right) => left.key.localeCompare(right.key));
  if (!objects.length) throw new Error("Replay expired or empty");
  if (objects.reduce((total, item) => total + item.size, 0) > maxBytes) throw new Error("Replay byte cap exceeded");
  const seqOf = (item) => {
    const match = item.key.startsWith(prefix) && /^(\d{4})\.json\.gz$/.exec(item.key.slice(prefix.length));
    if (!match) throw new Error("Replay has an unexpected chunk name; refusing a partial timeline");
    return Number(match[1]);
  };
  const seqs = objects.map(seqOf);
  const cache = join(directory, "chunks", meta.id);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const chunks = new Array(objects.length);
  let next = 0;
  let expanded = 0;
  await Promise.all(Array.from({ length: Math.min(4, objects.length) }, async () => {
    while (next < objects.length) {
      const index = next++;
      const item = objects[index];
      const version = hash(`${item.key}:${item.size}:${item.uploaded.toISOString()}`);
      const file = join(cache, `${version}.gz`);
      let bytes;
      if (existsSync(file)) bytes = readFileSync(file);
      else {
        const object = await reader.get(item.key);
        if (!object) throw new Error("Replay chunk disappeared; rerun discovery");
        bytes = Buffer.from(await object.arrayBuffer());
      }
      if (bytes.length !== item.size) throw new Error("Replay chunk size mismatch");
      const text = gunzipSync(bytes, { maxOutputLength: maxBytes }).toString("utf8");
      expanded += Buffer.byteLength(text);
      if (expanded > maxBytes) throw new Error("Expanded replay byte cap exceeded");
      const events = JSON.parse(text);
      if (!Array.isArray(events) || events.some((event) => !event || typeof event !== "object" || !Number.isFinite(event.timestamp) || !Number.isInteger(event.type))) throw new Error("Invalid rrweb chunk; refusing a partial timeline");
      if (!existsSync(file)) writePrivate(file, bytes);
      chunks[index] = events;
    }
  }));
  const events = chunks.flat().sort((left, right) => left.timestamp - right.timestamp);
  /* A chunk the browser never delivered is a hole in the session, not a reason to lose the rest of
     it (19 of 122 sessions refused, 2026-11-07). The hole is stated where it falls: `after` is the
     last moment before it, null when the session's opening is missing. */
  const gaps = [];
  for (let seq = 0, at = 0; seq <= seqs[seqs.length - 1]; seq++) {
    if (seqs[at] === seq) { at++; continue; }
    const before = at > 0 ? chunks[at - 1] : null;
    gaps.push({ seq, after: before?.length ? Math.max(...before.map((event) => event.timestamp)) : null });
  }
  const manifest = { id: meta.id, product: meta.product, day: meta.day, read_at: new Date().toISOString(), complete_for_listed_keys: true, missing_chunks: gaps.map((gap) => gap.seq), chunks: objects.map((item) => ({ key: item.key, size: item.size, uploaded: item.uploaded.toISOString() })), events: events.length };
  writePrivate(join(cache, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { events, manifest, gaps };
}
/** Timeline lines for the holes, to merge with the digest's lines. */
export function gapLines(gaps, start) {
  return gaps.map((gap) => ({
    t: gap.after ?? start,
    kind: "gap",
    text: gap.after === null
      ? `the recording's opening is missing (chunk ${gap.seq}): what is on screen before this line is unknown`
      : `chunk ${gap.seq} never arrived: anything may have happened here, often a page change such as a payment`,
  }));
}
