/*
  Edge HTTP security helpers:
   - IPv6 /64 prefix canonicalization for rate-limit keys (prevents /64 address rotation bypass).
   - Streaming byte-bounded body readers and gzip decompressor (prevents Worker 128 MB OOM before length checks).
   - Operator Content-Security-Policy and security headers (strict script-src 'self', connect-src 'self',
     while allowing owned product origins for stylesheets/images/fonts inside rrweb replay iframes).
*/
import { products } from "./products";

const hexGroup = (g: string) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16).toString(16) : g);

/** Normalizes IPv4 as-is and collapses IPv6 addresses to their canonical /64 prefix. */
export function rateLimitIpKey(rawIp: string | null | undefined): string {
  const ip = (rawIp ?? "").trim();
  if (!ip) return "none";
  // Strip IPv4-mapped IPv6 prefix ::ffff:1.2.3.4
  const v4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4Mapped) return v4Mapped[1]!;
  if (!ip.includes(":")) return ip;

  // Expand IPv6 (with optional :: compression) to 8 16-bit groups, keep first 4 (/64).
  const zoneless = ip.split("%")[0]!.toLowerCase();
  const halves = zoneless.split("::");
  if (halves.length > 2) return zoneless;
  const parsePart = (part: string) => (part ? part.split(":").filter(Boolean) : []);
  const left = parsePart(halves[0] ?? "");
  const right = halves.length === 2 ? parsePart(halves[1] ?? "") : [];
  if (halves.length === 2) {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return zoneless;
    const full = [...left, ...Array<string>(missing).fill("0"), ...right];
    return `${full.slice(0, 4).map(hexGroup).join(":")}::/64`;
  }
  if (left.length === 8) {
    return `${left.slice(0, 4).map(hexGroup).join(":")}::/64`;
  }
  return zoneless;
}

/** Reads a request body up to `maxBytes`, aborting immediately if exceeded (never buffers unbounded payloads). */
export async function readBoundedBytes(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const len = Number(declared);
    if (!Number.isFinite(len) || len < 0 || len > maxBytes) return null;
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Reads UTF-8 request text up to `maxBytes`, returning `null` if oversized or unreadable. */
export async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(req, maxBytes);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/** Decompresses gzip bytes with a strict ceiling on decompressed size to block gzip bombs. */
export async function gunzipBounded(compressed: Uint8Array, maxOutputBytes: number): Promise<Uint8Array | null> {
  if (!compressed.byteLength) return null;
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Builds strict security headers for the operator control app while allowing owned product assets in rrweb replays. */
export function operatorSecurityHeaders(rawProducts: unknown): Record<string, string> {
  const allowedHosts = new Set<string>();
  const list = typeof rawProducts === "string" || Array.isArray(rawProducts) ? products(rawProducts) : [];
  for (const p of list) {
    if (/^[a-z0-9.-]+$/i.test(p.domain)) {
      allowedHosts.add(`https://${p.domain}`);
      allowedHosts.add(`https://*.${p.domain}`);
    }
    for (const h of p.extraHosts ?? []) {
      if (/^[a-z0-9.-]+$/i.test(h)) allowedHosts.add(`https://${h}`);
    }
  }
  const prodOrigins = [...allowedHosts].join(" ");
  const withProd = (base: string) => (prodOrigins ? `${base} ${prodOrigins}` : base);
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    withProd("style-src 'self' 'unsafe-inline'"),
    withProd("img-src 'self' data: blob:"),
    withProd("font-src 'self' data:"),
    "media-src 'self' blob:",
    "frame-src 'self' blob: about:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "content-security-policy": csp,
  };
}
