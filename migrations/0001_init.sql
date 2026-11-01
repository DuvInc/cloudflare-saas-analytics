-- Cloudflare SaaS Analytics. D1 holds only small tables: one row per product-day, per person, per payment,
-- per replay session, per job run. Never one row per page view: raw events are files in R2
-- (Basin Pipelines sink, then one compacted file per day). See PLAN.md and SCHEMA.md.

-- The day's numbers per product and host. Tops are JSON arrays [{k, views, visitors}] (100 max).
CREATE TABLE days (
  product TEXT NOT NULL,
  host TEXT NOT NULL,                  -- '*' = every host of the product
  day TEXT NOT NULL,                   -- YYYY-MM-DD, UTC
  views INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0, -- distinct identities of the day (hash or cookie or user)
  visits INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  returning_visitors INTEGER NOT NULL DEFAULT 0, -- visitors with a cookie first seen before this day
  signups INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,   -- product (non-page) events
  bot_views INTEGER NOT NULL DEFAULT 0,
  revenue_cents INTEGER NOT NULL DEFAULT 0, -- in the product's main currency, from payments
  pages TEXT NOT NULL DEFAULT '[]',
  entries TEXT NOT NULL DEFAULT '[]',
  referrers TEXT NOT NULL DEFAULT '[]',
  channels TEXT NOT NULL DEFAULT '[]',
  ai_sources TEXT NOT NULL DEFAULT '[]',
  utm_sources TEXT NOT NULL DEFAULT '[]',
  utm_campaigns TEXT NOT NULL DEFAULT '[]',
  countries TEXT NOT NULL DEFAULT '[]',
  cities TEXT NOT NULL DEFAULT '[]',
  devices TEXT NOT NULL DEFAULT '[]',
  browsers TEXT NOT NULL DEFAULT '[]',
  os TEXT NOT NULL DEFAULT '[]',
  langs TEXT NOT NULL DEFAULT '[]',
  custom_events TEXT NOT NULL DEFAULT '[]',
  vitals TEXT NOT NULL DEFAULT '{}',   -- {lcp_p75, inp_p75, cls_p75, n}
  rolled_up_at TEXT NOT NULL,
  PRIMARY KEY (product, host, day)
) WITHOUT ROWID;

-- One person per product: the user of a product account. PII lives here only, never in raw files.
CREATE TABLE people (
  product TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  workspace_id TEXT,
  plan TEXT,
  traits TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  first_touch TEXT,                    -- JSON {channel, ai_source, referrer_host, utm_*, entry_path, country, at}
  attribution_method TEXT,             -- 'cookie' | 'hash' | 'utm_on_signup' | 'none'
  stripe_customer_id TEXT,
  ltv_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  replay_opt_out INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product, user_id)
) WITHOUT ROWID;
CREATE INDEX people_email ON people (email);
CREATE INDEX people_stripe ON people (stripe_customer_id);

-- Which anonymous identity became which person. kind: 'anon' (cookie) | 'hash' (day hash).
CREATE TABLE identities (
  product TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (product, kind, value)
) WITHOUT ROWID;

-- First time a cookie id was seen: "returning" and multi-day attribution without reading raw files.
CREATE TABLE anon_first (
  product TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  first_day TEXT NOT NULL,
  first_touch TEXT NOT NULL,
  PRIMARY KEY (product, anon_id)
) WITHOUT ROWID;

-- The landing of each visit of the last 3 days, keyed by identity, for signup attribution.
-- Written by the rollup and the live path (one row per visit, not per event), pruned after 3 days.
CREATE TABLE recent_visits (
  product TEXT NOT NULL,
  ident TEXT NOT NULL,                 -- 'h:<day_hash>' or 'a:<anon_id>'
  visit_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  touch TEXT NOT NULL,
  PRIMARY KEY (product, ident, visit_id)
) WITHOUT ROWID;

CREATE TABLE payments (
  id TEXT PRIMARY KEY,                 -- Stripe object id (in_, ch_, cs_, re_)
  product TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- 'checkout' | 'invoice' | 'refund' | 'charge'
  amount_cents INTEGER NOT NULL,       -- negative for refunds
  currency TEXT NOT NULL,
  stripe_customer_id TEXT,
  user_id TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  attribution TEXT,                    -- copy of the person's first touch at the time
  livemode INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX payments_product_day ON payments (product, created_at);

CREATE TABLE replay_sessions (
  id TEXT PRIMARY KEY,                 -- rs_...
  product TEXT NOT NULL,
  user_id TEXT,
  host TEXT,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  chunks INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  pages TEXT NOT NULL DEFAULT '[]',
  day TEXT NOT NULL
);
CREATE INDEX replay_sessions_product ON replay_sessions (product, started_at);
CREATE INDEX replay_sessions_user ON replay_sessions (product, user_id);

-- The ledger: one row per job and key (a day, a backfill). Health reads it.
CREATE TABLE runs (
  job TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  ran_at TEXT NOT NULL,
  note TEXT,
  files TEXT NOT NULL DEFAULT '[]',    -- compacted R2 keys written by the job (the CLI downloads them)
  PRIMARY KEY (job, key)
) WITHOUT ROWID;

-- Stripe webhook dedupe.
CREATE TABLE stripe_events (id TEXT PRIMARY KEY, at TEXT NOT NULL) WITHOUT ROWID;

-- Operator passkeys (WebAuthn).
CREATE TABLE operator_passkeys (
  id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]', label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE operator_sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, passkey_id TEXT, label TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at TEXT
);
CREATE TABLE operator_challenges (
  id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, code_hash TEXT,
  expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE operator_enrollments (
  code_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT, created_by TEXT NOT NULL
);
