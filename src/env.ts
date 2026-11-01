import type { Product } from "./products";

export type Env = {
  DB: D1Database;
  /** Optional natural-language filters: any OpenAI-compatible chat endpoint (OpenAI, OpenRouter, a Cloudflare AI Gateway URL, Workers AI compat). */
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  /** Raw (Basin sink), compacted daily files and replays. */
  BUCKET: R2Bucket;
  /** Day salts of the visitor hash (48 h TTL) and the per-product kill switch. */
  KV: KVNamespace;
  /** Basin Pipelines stream `saas_analytics_events`. Nothing else can feed it: HTTP ingest is off. */
  STREAM: { send(records: Record<string, unknown>[]): Promise<void> };
  ASSETS: Fetcher;
  PER_IP: RateLimit;
  PER_PRODUCT: RateLimit;
  /** The products (see products.ts): a JSON array in wrangler vars, a string in tests. */
  PRODUCTS: string | unknown[];
  OPERATOR_NAME: string;
  ENVIRONMENT?: string;
  /** "off" stops all collection at once without a deploy of the products. */
  COLLECT?: string;
  /** Secret: HMAC key of the user tokens the products hand to the browser, and of the operator CSRF token. */
  IDENTITY_SECRET?: string;
  OPERATOR_SECRET?: string;
  /** Secrets: where reports and alerts are posted. A Slack incoming webhook works as is; so does a Discord webhook with `/slack` appended; anything else receives the full JSON. */
  REPORT_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_URL?: string;
  /** Optional bearer sent with the webhook (for a generic receiver). */
  WEBHOOK_SECRET?: string;
  /** Secrets per product: STRIPE_KEY_<PRODUCT> (restricted, read only), STRIPE_WEBHOOK_SECRET_<PRODUCT>. */
  [key: `STRIPE_${string}`]: string | undefined;
  /** Secret: bearer for POST /s (server events from what is not a Worker: a script, a workflow tool). JSON {product: token}. */
  SERVER_TOKENS?: string;
  DEV_OPERATOR_EMAIL?: string;
  /** Bots (bots.ts): Zone Read + Zone Analytics Read on every site's zone, Account Analytics Read. */
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID: string;
  /** {since, extraSites: [{id, name, zone}], delivery: {zone: analytics engine dataset}} */
  BOTS?: string | Record<string, unknown>;
};

export type Ctx = ExecutionContext;
export const isDevelopment = (env: Env) => env.ENVIRONMENT === "development";
export type { Product };
