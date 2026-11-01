-- One sign-up event per person, whichever caller reports the account first (signup action,
-- OAuth return, auth webhook). NULL = the sign-up was not yet counted.
ALTER TABLE people ADD COLUMN signed_up_at TEXT;
-- Everyone before the fix already has (or never had) its event: only the people created since
-- 2026-10-31 without one are left for the reconciliation to count.
UPDATE people SET signed_up_at = created_at WHERE created_at < '2026-10-31' OR attribution_method IS NOT NULL;
