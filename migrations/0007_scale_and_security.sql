-- 1. Deduplicate recent_visits to one first-touch row per (product, ident) and index started_at for O(log N) hourly pruning.
CREATE TABLE recent_visits_v2 (
  product TEXT NOT NULL,
  ident TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  touch TEXT NOT NULL,
  PRIMARY KEY (product, ident)
) WITHOUT ROWID;

INSERT OR IGNORE INTO recent_visits_v2 (product, ident, started_at, touch)
  SELECT product, ident, started_at, touch FROM recent_visits ORDER BY started_at ASC;

DROP TABLE recent_visits;
ALTER TABLE recent_visits_v2 RENAME TO recent_visits;
CREATE INDEX IF NOT EXISTS recent_visits_started ON recent_visits (started_at);

-- 2. Pre-aggregate AI answer fetches on traffic_days so /api/overview reads 1 tiny row per (site, day) instead of scanning bot_days.
ALTER TABLE traffic_days ADD COLUMN ai_answers INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO traffic_days (site, day, bot_requests, other_requests, kinds, ai_answers)
  SELECT site, day, SUM(requests), 0, '{}', 0 FROM bot_days GROUP BY site, day;

UPDATE traffic_days SET ai_answers = COALESCE((
  SELECT SUM(b.requests) FROM bot_days b
  WHERE b.site = traffic_days.site AND b.day = traffic_days.day
    AND (
      lower(b.bot) GLOB 'chatgpt-user*' OR lower(b.bot) GLOB 'claude-user*' OR lower(b.bot) GLOB 'perplexity-user*'
      OR lower(b.bot) GLOB 'mistralai-user*' OR lower(b.bot) GLOB 'duckassistbot*' OR lower(b.bot) GLOB 'gemini-user*'
      OR lower(b.bot) GLOB 'google-notebooklm*' OR lower(b.bot) GLOB 'meta-externalfetcher*'
      OR lower(b.bot) GLOB 'manus*' OR lower(b.bot) GLOB 'devin*' OR lower(b.bot) GLOB 'operator*'
      OR (b.category = 'AI Assistant'
          AND lower(b.bot) NOT GLOB 'oai-searchbot*' AND lower(b.bot) NOT GLOB 'claude-searchbot*'
          AND lower(b.bot) NOT GLOB 'perplexitybot*' AND lower(b.bot) NOT GLOB 'gptbot*'
          AND lower(b.bot) NOT GLOB 'claudebot*' AND lower(b.bot) NOT GLOB 'meta-externalagent*')
    )
), 0);

-- 3. Replay chunk sequence deduplication (prevents overwrite amplification and metric inflation on retries).
CREATE TABLE IF NOT EXISTS replay_chunks (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS replay_chunks_day ON replay_chunks (day);

-- 4. Retention pruning indexes aligned with R2 lifecycles.
CREATE INDEX IF NOT EXISTS replay_sessions_day ON replay_sessions (day);
CREATE INDEX IF NOT EXISTS operator_sessions_expires ON operator_sessions (expires_at);
CREATE INDEX IF NOT EXISTS operator_enrollments_expires ON operator_enrollments (expires_at);
CREATE INDEX IF NOT EXISTS stripe_events_at ON stripe_events (at);
