/*
  "French traffic on my blog" -> filters. Optional: set AI_BASE_URL, AI_API_KEY and AI_MODEL (any
  OpenAI-compatible chat endpoint; a small model is enough, about $0.0001 a call) and the dashboard
  shows the sentence box; leave them unset and it stays hidden. The request carries a strict JSON
  schema and the product's real values (top channels, pages, countries...) so the model picks keys
  that exist. The answer is validated against the dimensions and operators the server knows before
  it is used.
*/
import type { Env } from "./env";
import { DIMENSIONS, type Filter, type Op } from "./explore";

const DESCRIBE: Record<string, string> = {
  channel: "acquisition channel of the visit's landing (values listed)",
  referrer: "referring site host, e.g. google.com",
  ai: "AI assistant that sent the visit (ChatGPT, Perplexity, Claude, Gemini...)",
  utm_source: "utm_source", utm_campaign: "utm_campaign",
  entry: "landing page path", page: "any page path seen in the visit",
  country: "ISO 3166-1 alpha-2 country code, upper case (FR, DE, US)",
  city: "\"City, CC\"", device: "desktop | mobile | tablet", browser: "browser family", os: "operating system",
  lang: "2-letter browser language (fr, en, de)", event: "a product event name",
};

export const aiEnabled = (env: Env) => Boolean(env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL);

export async function aiFilters(env: Env, text: string, values: Record<string, string[]>): Promise<Filter[]> {
  if (!aiEnabled(env)) throw new Error("Natural-language filters are not configured (AI_BASE_URL, AI_API_KEY, AI_MODEL).");
  const system = [
    "You turn a request about website analytics into filters. Reply with JSON only.",
    "Each filter: dim (one of the dimensions), op (is | not | contains), value.",
    "Use `contains` for a part of a path (\"blog\" -> page contains \"/blog\") or a fuzzy name. Use `is` with an exact value from the lists when one fits.",
    "Several filters are combined with AND. Return no filter for anything you cannot express.",
    "Dimensions:",
    ...DIMENSIONS.map((d) => `- ${d}: ${DESCRIBE[d]}${values[d]?.length ? `. Values: ${values[d]!.slice(0, 40).join(" | ")}` : ""}`),
  ].join("\n");
  const schema = {
    type: "object", additionalProperties: false, required: ["filters"],
    properties: { filters: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["dim", "op", "value"],
      properties: { dim: { type: "string", enum: [...DIMENSIONS] }, op: { type: "string", enum: ["is", "not", "contains"] }, value: { type: "string" } } } } },
  };
  const res = await fetch(`${env.AI_BASE_URL!.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.AI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.AI_MODEL,
      max_tokens: 400,
      messages: [{ role: "system", content: system }, { role: "user", content: text.slice(0, 500) }],
      response_format: { type: "json_schema", json_schema: { name: "filters", strict: true, schema } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The model did not answer (${res.status}).`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as { filters?: { dim: string; op: string; value: string }[] };
  return (parsed.filters ?? [])
    .filter((f) => (DIMENSIONS as readonly string[]).includes(f.dim) && ["is", "not", "contains"].includes(f.op) && typeof f.value === "string" && f.value.trim())
    .map((f) => ({ dim: f.dim as Filter["dim"], op: f.op as Op, value: f.dim === "country" ? f.value.trim().toUpperCase() : f.value.trim() }));
}
