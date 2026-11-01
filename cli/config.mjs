/* What the CLI needs to know about your deployment, read from wrangler.jsonc (never hard-coded). */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function readJsonc(file) {
  const text = readFileSync(file, "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === "\\") out += text[++i]; else if (c === '"') inString = false; continue; }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function deployment() {
  let wrangler;
  try { wrangler = readJsonc(path.join(root, "wrangler.jsonc")); }
  catch { throw new Error("wrangler.jsonc not found: run `npm run setup` first (see README)."); }
  return {
    root,
    worker: wrangler.name,
    database: wrangler.d1_databases?.[0]?.database_name,
    bucket: wrangler.r2_buckets?.[0]?.bucket_name,
    account: wrangler.vars?.CF_ACCOUNT_ID,
    /* Where the dashboard answers, for links (enrollment). Set ANALYTICS_URL, or let setup write it in vars. */
    dashboard: process.env.ANALYTICS_URL ?? wrangler.vars?.DASHBOARD_URL ?? "",
  };
}
