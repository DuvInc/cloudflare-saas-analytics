# AGENTS.md

Instructions for any AI agent working in this repository. One file, no per-vendor copy: Claude Code,
Cursor, Codex and the rest all read `AGENTS.md`.

Most rules below exist because the failure they prevent is silent. A quiet product looks like a
product with no visitors. A double-counted payment looks like revenue. A cookie set without consent
looks like a working tracker. Nobody notices until the data can no longer be fixed.

## What this repository is

A Cloudflare Worker that collects web and product analytics for the products of one operator, rolls
them up into small D1 tables and compacted R2 files, and serves a passkey-only dashboard, a CLI and
scheduled reports.

```text
browser / product Worker / Stripe ─► Worker ─► Pipelines stream ─► R2 raw/ ─► hourly + daily rollups ─► D1 + R2 daily/
                                       └────► R2 replays/ , D1 people / payments / replay_sessions
dashboard (web/) and CLI (cli/) read D1 and R2; the CLI reads them locally in DuckDB
```

## Layout

| Path | What it is |
| :--- | :--- |
| `src/index.ts` | the Worker: routes by host (a product's collection host vs the dashboard host), cron, private assets |
| `src/collect.ts` | `POST /e`: consent, DNT/GPC, bots, enrichment, the stream write, `recent_visits` |
| `src/rpc.ts` | the service-binding API products call: `track`, `identify`, `userToken`, `forget`; first-touch attribution and one-signup-per-person |
| `src/replay.ts` | `POST /r`: replay chunks, bounded gzip, dedup by `(session, seq)`, product scoping |
| `src/rollup.ts` | hourly compaction of today, the closed-day rollup, retention purges |
| `src/read-context.ts`, `src/explore.ts`, `src/journeys.ts`, `src/aggregate.ts` | reads: cached, bounded, streamed |
| `src/stripe.ts` | webhooks and reconciliation; revenue counts `livemode = 1` only |
| `src/bots.ts` | verified bots from Cloudflare's GraphQL analytics (optional) |
| `src/report.ts` | reports and alerts to a webhook |
| `src/operator/` | the dashboard API and passkey auth |
| `src/http-security.ts` | IPv6 /64 rate-limit keys, bounded body and gzip readers, the dashboard CSP |
| `config/` | **your** product definitions: event catalogs and funnels |
| `migrations/` | D1 schema, additive, numbered |
| `web/` | the dashboard (React, Tailwind, shadcn). `web/dev-mock.ts` serves invented data |
| `client/` | the browser code: tracker, replay recorder, replay player |
| `cli/` | `csa`: local DuckDB queries over a synced archive |
| `scripts/setup.mjs` | the installer (`--dry-run` plans without changing anything) |
| `SCHEMA.md` | every table and column, and the traps. Read it before stating a number |
| `test/` | Worker tests against SQLite and an in-memory R2 |

## Commands

```bash
npm run check        # types (Worker and dashboard) and tests. No network, no account
npm run dev:web      # the dashboard; MOCK=1 for invented data and no passkey
npm run setup -- --dry-run
npm run deploy       # builds the browser code and the dashboard, then wrangler deploy
npm run migrate      # D1 migrations, remote
npm run csa -- help  # the CLI
npm run screenshots  # docs/*.png and the social preview, from web/dev-mock.ts (Chrome needed). Never edit them by hand
```

## Rules

1. **Consent is the line.** `anon_id` and the `csa_id` cookie exist only after an explicit yes
   (`c === 1`), never under Do Not Track or Global Privacy Control, never for a bot. Any change in
   `src/collect.ts`, `src/rpc.ts` or `client/tracker.ts` that touches this needs a test.
2. **Cost is correctness.** D1 holds a row per product-day, per person, per payment, never per event.
   A dashboard load must not list `raw/`. Say in a PR how many D1 rows and R2 operations a change reads.
3. **One signup per person.** `people.signed_up_at` is claimed atomically; any caller may report the
   account first. A login is never a signup (`attributeSignup` only applies to accounts under 15
   minutes old), and a first touch is never overwritten or taken from a visit after the signup.
4. **Revenue is `livemode = 1`.** A one-off Checkout and its generated invoice are one purchase.
5. **Every read of the network is bounded**: bytes read in a stream, gzip output capped, rate limits
   keyed on the IPv6 /64.
6. **Private assets stay private**: `/android/*`, `/player.js`, `/products/*` need an operator session.
7. **Migrations are additive** and tested on a copy of real data before they ship.
8. **The Worker never prints a secret**, and the CLI never writes outside `.archive/`.
9. **Comments explain why.** Keep the long ones; they record what broke.
10. **No em dashes**, anywhere.

## Things that bite

- `wrangler.jsonc` is generated and gitignored; `wrangler.example.jsonc` is the template.
- The rollup of a closed day is skipped if its manifest is empty (zero R2 reads): do not "fix" it.
- The product hosts must not route the dashboard: the dashboard host is `workers.dev`.
- A zone that already has a wildcard Worker route (`*.example.com/*`) wins over the collection
  custom domain: add a more specific route for the collection host.
- `STREAM` (Pipelines) needs the Workers Paid plan.
- After adding a collection endpoint, add its path to the WAF rule of every zone.
