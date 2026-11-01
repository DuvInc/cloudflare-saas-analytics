---
name: cloudflare-saas-analytics
description: Install, query and extend cloudflare-saas-analytics, the Cloudflare Worker that measures a SaaS (page views, AI-assistant traffic, funnels, signup attribution, Stripe revenue, session replay). Use to set it up on a Cloudflare account, wire a product to it, answer a traffic or conversion question with the csa CLI, or change what it collects.
---

# cloudflare-saas-analytics

Read `AGENTS.md` first (rules and layout) and `SCHEMA.md` before stating any number.

## Install on a Cloudflare account

1. `npx wrangler login`, then `npm ci`.
2. `npm run setup -- --dry-run` and show the user what it will create. Setup creates D1, R2, KV and a
   Pipelines stream in their account (Workers Paid plan), so get a yes before the real run.
3. `npm run setup`. If a step fails, read the error, fix the cause, run it again: finished steps are skipped.
4. `npm run csa -- enroll` and give the user the link. They open it on the device to register a passkey.
5. For each product: the `<script>` tag, the service binding, and the WAF rule from the README.

## Wire a product

- Site: `<script defer src="https://<collect host>/t.js"></script>`.
- App: the `ANALYTICS` service binding with `props.product`. `identify({ signup: true, seen })` on
  creation; from an OAuth callback, `identify({ attributeSignup: true, seen })`. `track` for events.
  `seen` is empty under Do Not Track and Global Privacy Control.
- Definitions: `config/events/<product>.json` and `config/funnels/<product>.json`, imported in `config/index.ts`.

## Answer a question

```bash
npm run csa -- sync --days 90          # closed days and D1 tables, locally
npm run csa -- overview --days 30
npm run csa -- channels --product <id>
npm run csa -- user someone@example.com
npm run csa -- sql "SELECT ... FROM events"
```

Today's figures come from `csa today` (raw files). State the period and whether it is closed days only.
Visitors do not add up across days (a level-0 visitor changes hash daily): quote visits for multi-day totals.

## Change it

`npm run check` before and after. A change to collection, attribution, revenue or auth needs a test.
Never loosen consent, the CSP or the private-asset rules to make something work.
