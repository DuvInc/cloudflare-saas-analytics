# Security policy

## Reporting a vulnerability

Please report privately rather than in a public issue, using GitHub's
[private vulnerability reporting](https://github.com/DuvInc/cloudflare-saas-analytics/security/advisories/new)
on this repository.

This is an early, one-person project. You should get an acknowledgement within a few days; if a
week passes with no reply, feel free to nudge by opening a public issue that says only that you are
waiting on a private report, with no details.

## What is in scope

This Worker collects page views and events from your visitors' browsers, holds the keys that sign
your users' tokens, and serves a dashboard that can replay their sessions. The interesting surface:

- **Sign-in to the dashboard.** Passkeys only (`src/operator/auth.ts`). Anything that lets someone
  sign in, register a passkey, or keep a session without the one-time enrollment link, or that lets a
  session outlive its revocation.
- **Private assets and the replay player.** Replays render visitors' pages inside the operator's
  browser. The Content-Security-Policy (`src/http-security.ts`) keeps that player from loading
  anything outside your own product origins. A way to make it call out, or to read another
  product's replay, is in scope.
- **The collection endpoints** (`/e`, `/r`, `/s`, `/stripe/<product>`). Unbounded reads, gzip bombs,
  rate-limit bypasses (for example by rotating IPv6 addresses), a way to write another product's
  data, forged Stripe events, and anything that makes the Worker's cost unbounded.
- **Privacy guarantees.** No IP address is stored. `anon_id` is never recorded without an explicit
  yes from the visitor, and never under Do Not Track or Global Privacy Control. A change that stores
  more personal data, or that lets a cookie identify a person without consent, is in scope.
- **The tokens.** `IDENTITY_SECRET` signs user tokens the browser carries; `SERVER_TOKENS` guards
  `/s`; Stripe keys and webhook secrets. Anything that logs, returns or leaks them.
- **The CLI.** `csa` runs queries locally in DuckDB and reads R2 with credentials from your `.env`.
  A command that writes outside this repository's `.archive/` or prints a secret is in scope.

## What is out of scope

- Cloudflare itself: Workers, D1, R2, Pipelines, the WAF. Report those to Cloudflare.
- Data quality. A wrong count is a bug, not a vulnerability.
- A vulnerability that requires the attacker to already have access to your Cloudflare account, your
  machine, or an unlocked signed-in device.
- Missing hardening in a deployment you changed (an extra route, a loosened CSP).

## If you deployed this

Three things this repository cannot do for you:

- **Keep the secrets out of transcripts.** If an AI agent ever printed `IDENTITY_SECRET`,
  `OPERATOR_SECRET`, an enrollment link or a Stripe key, consider it leaked and rotate it.
- **Scope the Cloudflare token for bots.** `CF_ANALYTICS_TOKEN` needs Zone Read and Analytics Read on
  the listed zones only.
- **Add the WAF rule** from the README, so scanners hitting your collection hosts never reach the
  Worker.

## If you forked this tool

Replace the link above with your own repository. This file arrived with the code and points at
somebody else's advisories.
