-- The users list and sign-ups by origin read people by product and creation date; the revenue
-- breakdown reads a payer's first payment.
CREATE INDEX IF NOT EXISTS people_created ON people (product, created_at);
CREATE INDEX IF NOT EXISTS payments_user ON payments (product, user_id, created_at);
