# Reading the bots data without fooling yourself

(Written after these mistakes were made on a real site. Applies to every site in the archive.)

This exists because of a real mistake, made in this project, in front of the
person who pays for the work: a correlation was computed, presented as an
answer, tightened by one join condition, and it changed by **30x on the same
bot** — and that swing almost got reported as a new finding instead of as proof
the method was worthless. Read this before you repeat it.

## 1. What this archive can answer, and what it structurally cannot

It can answer: which verified bot, how often, which path, which kind
(page/twin/llms/og/feed/asset), which section, which locale, which country,
which HTTP status, per window (one hour; the imported history before 2026-10-31 has 1 h, 4 h or 24 h windows).
Schema: `src/bots.ts` and SCHEMA.md. Query it with
`node cli/csa.mjs sql "…"` after `csa sync --bots` (DuckDB, local, free) — the views are `ai_crawl`
and `traffic_totals`.

It **cannot** answer, ever, no matter how the query is written:

- **How a bot found a URL.** There is no `referer` column — Cloudflare locks
  that dimension behind a paid tier the account doesn't have, and this is
  written down in `src/bots.ts`. No amount of SQL
  cleverness recovers a field that was never collected.
- **The order requests happened in.** Rows are counts aggregated per window (1 h, older history 4 h), not
  a request log. "Did it fetch the HTML then the twin" is not a question this
  schema can hold an answer to — there is no timestamp finer than the window,
  and no session or request ID to sequence within it.

If a question in this shape comes up — "did they find it via the link on the
page", "did this crawl follow that redirect", "was this a click or a scan" —
say plainly that the archive cannot answer it, and say why (no referer, no
per-request order), before offering anything else. Do not let a workaround
(co-occurrence in the same day, same hour, whatever) get presented as if it
closes the question. At best it is weak circumstantial evidence; say that
explicitly, every time, in the same sentence as the number.

## 2. The tell that a correlation is worthless: it moves when you tighten it

Concretely, what happened: "same day" co-occurrence between a bot's twin (.md)
fetches and its HTML fetches of the same path gave ClaudeBot 60%. Tightening
the join to "same hour" — a stricter, more honest version of the same
question — gave 2%. Same bot, same underlying data, one condition changed,
answer changed by 30x.

**That instability is the finding.** Not "ClaudeBot discovers pages
differently at different times of day" — the sample is too thin and the
mechanism too indirect for that story to be anything but invented. The correct
reaction, the moment two granularities of the same correlation disagree by an
order of magnitude, is to stop and say the method does not produce a stable
answer — not to pick one of the two numbers, and not to keep computing a third
variant looking for one that "makes sense."

**Rule:** before reporting a correlation-based read (co-occurrence, "X often
happens near Y"), compute it at two different granularities or two different
join conditions. If they roughly agree, say the finding with its caveats. If
they disagree by more than ~2x, the finding is "the method is unreliable at
this sample size", not the number from whichever run happened to be shown.

## 3. Always `SUM(requests)`, never `COUNT(*)`

Each row in `ai_crawl` / `traffic_totals` is a GROUP with its own
`requests` count already folded in (see `fold()` in `index.ts` — two
different User-Agent strings that both resolve to the same `bot_name` collapse
into one row with summed requests). `COUNT(*)` counts *rows* — distinct
(hour, path, status, …) combinations — which is a real number but not the one
almost every question is actually asking. It was used by mistake in this
project's first pass at a co-occurrence query and produced a total that did
not match the volume already reported minutes earlier in the same
conversation, which is exactly the kind of silent inconsistency to look for:
**if a new query's total does not reconcile with a total already reported for
the same slice, find out why before presenting the new number.**

```sql
-- wrong: counts groups, not traffic
SELECT bot_name, COUNT(*) FROM ai_crawl WHERE kind = 'twin' GROUP BY bot_name;

-- right: counts requests
SELECT bot_name, SUM(requests) FROM ai_crawl WHERE kind = 'twin' GROUP BY bot_name;
```

## 4. Reads that are safe, and why

These describe traffic that happened — they carry no claim about mechanism or
causality, so they don't have trap #1's problem:

- Locale split by `kind` (`SUM(requests) GROUP BY locale, kind`). Exclude
  locale-agnostic `kind`s (`asset`, `og`, `feed`, `llms`) from an "English vs.
  other locales" read, or the empty-locale bucket (assets have no locale
  prefix, so they inflate `''` = English) will make the split look far more
  English-skewed than the actual localized content is. Compare `page` and
  `twin` only for that question.
- Per-bot totals, per-bot-per-locale breakdowns, per-section breakdowns,
  day-over-day trend. All of these are direct sums of what happened; none of
  them require inferring *why*.
- Crawl waste (`status != 200` grouped by status): a fact about what was
  served, not a claim about intent.

## 5. Health before numbers, always

Check the `runs` ledger (`npm run csa -- health`) before quoting any bot number: a range with missing
or failed hours reported as a clean total is worse than no total, because nothing about it looks
wrong. Beyond collection, the interpretation traps above are the ones that show up only once you
start asking questions of the data. Also keep in mind: the 10,000-group cap per window, `'other'`
is not `'human'`, and a bot name is never empty.
