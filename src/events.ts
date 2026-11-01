/*
  Event names and properties. Product events are `noun_verbed` (past tense, snake_case), declared
  per product in events/<product>.json. An undeclared name is stored and counted by the health
  check (`unknown_events`), never refused: fixing the catalog is cheaper than losing the data.
  Built-ins start with `$`: $pageview, $pageleave, $consent (consent answered: carries the landing, not a view).
*/
const NAME = /^(\$pageview|\$pageleave|\$consent|[a-z][a-z0-9_]{1,63})$/;
export const eventName = (v: unknown) => (typeof v === "string" && NAME.test(v) ? v : "");

/* Never in analytics, whatever a product sends: content, credentials, contact details. */
export const BLOCKED_KEYS = new Set([
  "email", "user_email", "mail", "phone", "name", "first_name", "last_name", "full_name", "address",
  "password", "token", "secret", "api_key", "apikey", "authorization", "cookie",
  "filename", "file_name", "title", "notes", "instruction", "prompt", "result", "content", "message", "body", "text",
  "storage_path", "error_message", "ip",
]);

/** Flat props only: string (200), number, boolean; 30 keys; blocked keys dropped. JSON string or null. */
export function cleanProps(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 30) break;
    const key = k.toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key) || BLOCKED_KEYS.has(key)) continue;
    if (typeof val === "string") out[key] = val.slice(0, 200);
    else if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
    else if (typeof val === "boolean") out[key] = val;
    else continue;
    n++;
  }
  return n ? JSON.stringify(out) : null;
}
