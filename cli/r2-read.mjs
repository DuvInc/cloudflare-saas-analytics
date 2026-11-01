import { createHash, createHmac } from "node:crypto";
import { deployment } from "./config.mjs";
import { request } from "node:https";
import { credentials } from "./archive.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const xml = (value) => value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]);
export function parseListing(text) {
  const objects = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => ({
    key: xml(/<Key>([\s\S]*?)<\/Key>/.exec(block)[1]),
    uploaded: new Date(/<LastModified>(.*?)<\/LastModified>/.exec(block)[1]),
    size: Number(/<Size>(.*?)<\/Size>/.exec(block)[1]),
  }));
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
  const cursor = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/.exec(text)?.[1];
  if (truncated && !cursor) throw new Error("Truncated R2 list without cursor");
  return { objects, truncated, cursor: cursor ? xml(cursor) : undefined };
}
export class R2Reader {
  constructor(root) { this.keys = credentials(root); this.count = { get: 0, list: 0 }; }
  async fetch(key = "", params = {}) {
    const host = `${deployment().account}.r2.cloudflarestorage.com`;
    const pathname = `/${deployment().bucket}/${key.split("/").map(encode).join("/")}`;
    const query = Object.entries(params).filter(([, value]) => value !== undefined).map(([name, value]) => [encode(name), encode(value)]).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}=${value}`).join("&");
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const scope = `${date.slice(0, 8)}/auto/s3/aws4_request`;
    const headers = `host:${host}\nx-amz-content-sha256:${hash("")}\nx-amz-date:${date}\n`;
    const canonical = `GET\n${pathname}\n${query}\n${headers}\nhost;x-amz-content-sha256;x-amz-date\n${hash("")}`;
    const signing = hmac(hmac(hmac(hmac(`AWS4${this.keys.R2_SECRET_ACCESS_KEY}`, date.slice(0, 8)), "auto"), "s3"), "aws4_request");
    const signature = hmac(signing, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString("hex");
    return new Promise((resolve, reject) => {
      const req = request(`https://${host}${pathname}${query ? `?${query}` : ""}`, { method: "GET", headers: {
        "x-amz-content-sha256": hash(""), "x-amz-date": date,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.keys.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      } }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => { size += chunk.length; if (size > 64 * 1024 * 1024) req.destroy(new Error("R2 object exceeds 64 MiB read cap")); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === 404) return resolve(null);
          if (response.statusCode !== 200) return reject(new Error(`R2 read HTTP ${response.statusCode}`));
          resolve({ bytes: Buffer.concat(chunks), headers: response.headers });
        });
      });
      req.setTimeout(60_000, () => req.destroy(new Error("R2 read timeout")));
      req.on("error", reject); req.end();
    });
  }
  async list({ prefix, cursor, limit = 1000 }) {
    this.count.list++;
    const result = await this.fetch("", { "list-type": "2", prefix, "continuation-token": cursor, "max-keys": String(limit) });
    if (!result) throw new Error("R2 bucket not found");
    return parseListing(result.bytes.toString("utf8"));
  }
  async get(key) {
    this.count.get++;
    const result = await this.fetch(key);
    if (!result) return null;
    return { arrayBuffer: async () => result.bytes, text: async () => result.bytes.toString("utf8"), json: async () => JSON.parse(result.bytes.toString("utf8")), httpMetadata: { contentType: result.headers["content-type"], contentEncoding: result.headers["content-encoding"] } };
  }
}
