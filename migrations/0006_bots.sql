-- Machines reading the sites (verified bots, from Cloudflare's zone logs), one row per site, UTC
-- day and bot. The detail (every path, country, status, per hour) stays in R2
-- `bots/<zone>/crawl/<day>/<HH>.ndjson.gz`; D1 holds tens of rows a day, never one per path
-- (bots-analytics measured that per-path rows in D1 were 83% of the account's bill).
CREATE TABLE bot_days (
  site TEXT NOT NULL,
  day TEXT NOT NULL,
  bot TEXT NOT NULL,
  category TEXT NOT NULL,      -- Cloudflare's verified bot category: AI Assistant, AI Crawler, AI Search, Search Engine Crawler...
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL,     -- 4xx and 5xx served to it
  pages TEXT NOT NULL,         -- JSON [{k: path, n}] top 200
  kinds TEXT NOT NULL,         -- JSON {page, twin, llms, feed, og, asset}
  statuses TEXT NOT NULL,      -- JSON {"200": n, "404": n}
  countries TEXT NOT NULL,     -- JSON {FR: n}
  hosts TEXT NOT NULL,         -- JSON {host: n}
  PRIMARY KEY (site, day, bot)
) WITHOUT ROWID;

-- Every request of the zone that day, bots and others, by kind: the denominator of "share of traffic".
CREATE TABLE traffic_days (
  site TEXT NOT NULL,
  day TEXT NOT NULL,
  bot_requests INTEGER NOT NULL,
  other_requests INTEGER NOT NULL,
  kinds TEXT NOT NULL,         -- JSON {kind: {bot, other}}
  PRIMARY KEY (site, day)
) WITHOUT ROWID;

-- What a site's own Worker served to agents (Analytics Engine; a docs site: format, MCP tool).
CREATE TABLE delivery_days (
  site TEXT NOT NULL,
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  format TEXT NOT NULL,
  tool TEXT NOT NULL,
  bot TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (site, day, surface, format, tool, bot)
) WITHOUT ROWID;
