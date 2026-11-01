## What this changes

<!-- One or two sentences. If it fixes an issue, write "Fixes #123". -->

## Why

<!-- What was counted wrongly, lost, exposed, or impossible to ask before. -->

## Checklist

- [ ] `npm run check` passes locally (types and tests)
- [ ] Commits are signed off (`git commit -s`); see CONTRIBUTING.md
- [ ] A change to what is collected, stored or read comes with a test that shows the new behaviour
- [ ] A change that touches consent, `anon_id`, Do Not Track or Global Privacy Control is called out in the description
- [ ] A change to a query says what it reads in D1 rows and R2 operations (the cost is the feature)
- [ ] A new migration is additive, numbered, and applies to a copy of a real database
- [ ] No secret, no real visitor data and no real domain in this diff
