# Cloudflare SaaS Analytics: schema and definitions

Every number Cloudflare SaaS Analytics gives is defined here once. An agent reads this before stating a
figure, and quotes the provenance line `csa` prints (period, product, last sync).

All times are **UTC**. A "day" is a UTC day. Closed days come from the nightly compaction; today
comes from the raw files (`csa today`, `--live`).

## Freshness and measurement availability

Dashboard source and filtered-result memory caches last at most 120 seconds per entry; derived
answers cannot outlive the earliest cached source read by their request. Browser
responses last 30 seconds. These windows may add on successive reads. Upstream Basin buffering
still applies. Refresh bypasses both caches; it cannot flush an upstream buffer. Closed-day
filtered objects are versioned by the successful rollup's `ran_at`; open/unfinished days never
receive a persistent filtered result, even if temporarily empty. No event or query dimension is
discarded for speed. The 16 MiB cache budget is an estimated weight, not an exact JS heap bound.

A funnel may carry `unavailable`: the UI must show why it is not measurable, never interpret it
as a measured 0% conversion. The definition stays in code. A page step can supply `paths`, an OR
of literal/glob routes, with `value` as its display label. This includes localized and legacy
CSR job routes in one population. See PERFORMANCE.md for actual emitter evidence and missing stages.

Replay candidate duration is elapsed wall time (`last_at - started_at`), not active time.
Candidate scores are local heuristics, not modeled intention or proof of a customer issue.
Local exports are outside the remote retention lifecycle; they require explicit cleanup.

## Where each thing lives

| Data | Store | Kept | Read with |
|---|---|---|---|
| Raw events, today and yesterday | R2 `raw/*.json.gz` (Basin sink, a file every ≤ 5 min) | until the day is compacted | `csa today`, `csa sql ... --live` |
| Events of a closed day, visits filled in | R2 `daily/<day>/part-NNN.ndjson.gz`, then `.archive/events/<day>.parquet` locally | 25 months | view `events` after `csa sync` |
| Daily numbers per product and host | D1 `days` | forever | view `days`, dashboard |
| People (product accounts), their origin and LTV | D1 `people` | while the account exists | view `people` |
| Which anonymous identity became which person | D1 `identities` | same | view `identities` |
| Payments | D1 `payments` | forever | view `payments` |
| Replays | R2 `replays/<product>/<day>/<session>/NNNN.json.gz` + D1 `replay_sessions` | 30 days (chunks) | `csa replays`, dashboard |
| Job ledger | D1 `runs` | forever | `csa health` |
| Machines reading the sites (verified bots), per path and hour | R2 `bots/<zone>/crawl/`, `bots/<zone>/totals/`; per bot and day D1 `bot_days`, `traffic_days`, `delivery_days` | forever | screen AI & bots; views `ai_crawl`, `traffic_totals` after `csa sync --bots` (always `SUM(requests)`, a row is a group) |

## `events` (one row per event)

| Column | Meaning |
|---|---|
| `ts`, `received_at` | ms epoch: browser clock, server clock. **Days, ordering and sessions use `received_at`.** |
| `product`, `host`, `surface` | `acme`, `app.acme.com`, `website` / `docs` / `app` / `server` |
| `event`, `origin` | `$pageview`, `$pageleave` (engagement of the page just left), `$consent` (consent answered, carries the landing; not a view), or a product event (`noun_verbed`, catalog in `config/events/<product>.json`); `web` or `server` |
| `level` | 0 anonymous (day hash only), 1 consent cookie, 2 signed-in user |
| `day_hash` | visitor of the day: hash of IP + UA with a key that changes every UTC day (deleted after 48 h). Same hash across the product's hosts on one day; a new one tomorrow. Empty for bots and for DNT / GPC browsers |
| `anon_id` | the `csa_id` cookie, only after consent, lives 13 months |
| `user_id`, `workspace_id` | from the signed user token (browser) or the product's server call |
| `visit_id` | filled by compaction: same identity, no gap over 30 min. Empty in raw files |
| `path` | without query string |
| `referrer_host`, `referrer_path` | external referrer only (internal navigation is blank) |
| `channel` | first rule that matches: Paid Search / Paid Social / Paid Other, **AI**, Email, Organic Video, Organic Social, Organic Search, Referral, Campaign / Affiliate (UTM without referrer), Direct, Internal |
| `ai_source` | ChatGPT, Perplexity, Claude, Gemini, Copilot, Grok, DeepSeek, Le Chat, Meta AI, ... (`src/channels.ts`) |
| `utm_*`, `click_id_kind` | lower-cased UTMs; `ref` and `source` count as `utm_source`; the kind of click id (`google`, `meta`...), never its value |
| `country`, `region`, `city`, `continent`, `timezone`, `asn`, `as_org`, `is_datacenter` | Cloudflare's geolocation of the IP (the IP itself is never stored); `is_datacenter` = a hosting network (scripts, sometimes VPNs) |
| `lang`, `langs` | `navigator.language`; first three of `Accept-Language` |
| `device`, `browser`, `browser_major`, `os`, `os_major` | families from the User-Agent and Client Hints |
| `screen`, `viewport` | rounded to 10 px |
| `engaged_ms`, `scroll_pct`, `lcp_ms`, `inp_ms`, `cls` | on `$pageleave`: visible time on the page, deepest scroll, Web Vitals |
| `is_bot`, `bot_reason` | `verified:<category>`, `user_agent`, `webdriver`. Bots are excluded from every count |
| `props` | JSON string of the product event's properties (flat; content, emails and secrets are dropped at the door) |

## `days` (one row per product, host, UTC day; host `*` = the whole product)

`views` (page views), `visitors` (distinct identities of the day: user > cookie > day hash),
`visits`, `bounces` (one page view, under 10 s engaged, no product event), `engaged_ms` (sum over
visits), `returning_visitors` (a cookie first seen before that day), `signups`
(`signup_completed`, emitted once per person: `people.signed_up_at` is claimed by the first of `identify` with `signup`, `identify` with `attributeSignup` on an account under 15 min old, or the hourly reconciliation of accounts nobody counted), `events` (product events), `bot_views`, `revenue_cents` (payments that day,
host `*` only), and tops as JSON `[{k, views, visits, visitors}]` (100 max): `pages`, `entries`,
`referrers`, `channels`, `ai_sources`, `utm_sources`, `utm_campaigns`, `countries`, `cities`,
`devices`, `browsers`, `os`, `langs`, `custom_events` (`{k, count, users}`), and `vitals`
(`{lcp_p75, inp_p75, cls_p75, n}`).

## `people`, `identities`, `payments`, `replay_sessions`

- `people`: `product`, `user_id`, `email`, `name`, `workspace_id` (first seen), `plan`, `created_at`,
  `last_seen_at` (at most hourly), `first_touch` (JSON: `channel`, `ai_source`, `referrer_host`,
  `utm_*`, `entry_path`, `host`, `country`, `at`), `attribution_method`, `stripe_customer_id`,
  `ltv_cents` (live payments), `replay_opt_out`.
- `attribution_method`: `cookie` (the visitor had accepted analytics: exact, any number of days),
  `hash` (no consent: the signup came from the same IP and browser as a landing in the last ~48 h,
  a strong guess, wrong behind a shared office IP), `utm_on_signup` (the product passed UTMs),
  `none` (nothing found: count as Direct/unknown, **not** as Direct traffic).
- `payments`: one row per paid invoice, one-off Checkout, or refund (negative, cumulative per
  charge). `attribution` is the person's `first_touch` copied at payment time. `livemode = 0` is
  test mode: exclude it.
- `replay_sessions`: `id` (`rs_...`), `user_id`, `started_at`, `last_at`, `chunks`, `bytes`,
  `clicks`, `errors` (uncaught errors in the page), `pages`, `day`.

## Traps (read before concluding)

1. **Visitors do not add up across days.** A level-0 visitor gets a new hash every day, so
   `SUM(visitors)` over a month is **visitor-days**, not people. For people over a period, use
   `COUNT(DISTINCT anon_id)` (consenting visitors only) or `people`. Say which.
2. **AI is a floor.** Assistant apps often strip the referrer (those visits are Direct), and
   Google AI Overviews / AI Mode look like Google Search. Cross with Search Console (`treg`) and
   with `ai_crawl` (which pages GPTBot / ChatGPT-User read).
3. **Consent splits the population.** Returning visitors, multi-day attribution and `anon_id` exist
   only for visitors who accepted (and only where the product has a banner: some products have none, so
   it is all level 0 except signed-in builders). Never compare level-1 rates with the whole traffic.
4. **Server events have no geography and no browser** (`origin = 'server'`). Count people with
   them, not countries.
5. **Today is partial and uncompacted** (`visit_id` empty, the last ≤ 5 minutes missing).
6. **Bots**: always `NOT coalesce(is_bot, false)` on `events`. The tracker needs JavaScript, so
   most crawlers never reach it; the bots data (`src/bots.ts`) is where machines are counted.
7. **Preview and local hosts never arrive** (the collector drops hosts outside the product's domain),
   so no `$host` filtering is needed, unlike PostHog.
8. **Revenue currency**: `revenue_cents` sums every payment of the day whatever its currency;
   check `payments.currency` before comparing products.
9. **Replays are signed-in users only**, everything in clear (customers' content included) except
   passwords and `[data-secret]` blocks; pages showing API keys are absent. A missing page in a
   replay is often an excluded path, not a bug.

## Examples

```sql
-- Signups and revenue by AI assistant, last 30 days
SELECT product, coalesce(first_touch->>'ai_source', '(not AI)') AS ai, COUNT(*) AS signups, SUM(ltv_cents) / 100 AS revenue
FROM people WHERE created_at >= (now() - INTERVAL 30 DAY)::VARCHAR GROUP BY ALL ORDER BY signups DESC;

-- Entry pages that lead to a signup the same day (level-0 included, through the hash method)
SELECT p.product, p.first_touch->>'entry_path' AS entry, COUNT(*) AS signups
FROM people p WHERE p.attribution_method IN ('cookie', 'hash') GROUP BY ALL ORDER BY signups DESC;

-- Pages read by AI crawlers vs humans arriving from AI, same week (after csa sync --bots)
SELECT path, SUM(requests) AS crawls FROM ai_crawl WHERE bot_category ILIKE '%ai%' AND day >= '2026-10-24' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```
