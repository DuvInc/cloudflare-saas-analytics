# Contributing

Thanks for looking. This project is early and maintained by one person on a best-effort basis, so
the most useful thing you can do before writing code is open an issue or a discussion. Feedback on
what is missing or confusing is as valuable as a patch. A small fix is always welcome; a large one
is worth agreeing on first.

## Getting set up

Node 22 or newer.

```bash
npm ci
npm run check    # types (Worker and dashboard) and tests: no network, no Cloudflare account
npm run dev:web  # the dashboard against invented data (web/dev-mock.ts)
```

`npm run check` passes on a fresh clone. If it does not, that is a bug worth reporting on its own.
To exercise the real path you need a Cloudflare account on the Workers Paid plan and a zone: see the
README, `npm run setup -- --dry-run` shows every command first.

## Sign your commits off

Every commit needs a `Signed-off-by` line, which certifies that you wrote the patch or otherwise
have the right to submit it under the MIT licence. This is the
[Developer Certificate of Origin](https://developercertificate.org): one line, no paperwork, no
copyright assignment.

```bash
git commit -s -m "Your message"
```

## What makes a change likely to be merged

**It comes with a test.** Collection, attribution, rollups, funnels, replay and auth each have tests
(`test/`) that run the Worker against SQLite and an in-memory R2. Several exist because of a bug that
shipped once. If you change what is collected, counted or authorised, add the case that shows it.

**Cost is part of correctness.** The design keeps D1 to small tables (a row per product per day, per
person, per payment) and R2 to compacted files. A query that reads a row per event, or lists `raw/` on
every dashboard load, is a regression even if it returns the right number. Say in the PR how many D1
rows and R2 operations your change reads.

**Privacy is not negotiable.** Nothing identifying is stored without an explicit yes. Do Not Track
and Global Privacy Control win over a cookie. Read `src/collect.ts` before touching consent.

**Migrations are additive.** A new file in `migrations/`, numbered, safe on a copy of a real database.

**No new dependency** without an argument in an issue.

**Comments explain why, not what.** The existing ones are long on purpose: they record what went
wrong before.

**No em dashes**, anywhere.

## Reporting a bug

Include the commit, your plan, the number of products, and the rows of `runs`
(`npm run csa -- health`). Do not paste a secret, an enrollment link or visitor data. For anything
with security implications, read [SECURITY.md](./SECURITY.md) instead of opening a public issue.
