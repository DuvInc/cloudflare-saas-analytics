-- Saved funnels of the dashboard (steps: JSON [{kind: "page" | "event", value}]).
CREATE TABLE funnels (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX funnels_product ON funnels (product);
