CREATE TABLE IF NOT EXISTS market_catalog (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'General',
  image_url text,
  outcomes jsonb NOT NULL DEFAULT '["Yes", "No"]'::jsonb,
  initial_probabilities jsonb,
  closes_at timestamptz NOT NULL,
  resolution_source text,
  edge_cases text,
  oracle_type text NOT NULL DEFAULT 'manual',
  initial_liquidity numeric NOT NULL DEFAULT 20000,
  status text NOT NULL DEFAULT 'open',
  featured boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE market_events
  ADD COLUMN IF NOT EXISTS catalog_market_id text;

CREATE INDEX IF NOT EXISTS market_catalog_status_category_idx
  ON market_catalog (status, category, featured DESC);

CREATE INDEX IF NOT EXISTS market_events_catalog_market_id_idx
  ON market_events (catalog_market_id)
  WHERE catalog_market_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS market_events_group_catalog_unique_idx
  ON market_events (group_id, catalog_market_id)
  WHERE catalog_market_id IS NOT NULL;

ALTER TABLE market_catalog DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE market_catalog TO anon;
