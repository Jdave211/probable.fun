-- Probable — Supabase schema
-- Run this in the Supabase SQL editor before starting the backend.

-- Required for gen_random_uuid() on the group_members table.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Groups
CREATE TABLE IF NOT EXISTS groups (
  id          text        PRIMARY KEY,
  name        text        NOT NULL,
  emoji       text        NOT NULL DEFAULT '📣',
  mode        text        NOT NULL DEFAULT 'fake',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Members of each group (+ their fake-money balance)
CREATE TABLE IF NOT EXISTS group_members (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    text        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  balance     numeric     NOT NULL DEFAULT 100000.0,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, name)
);

-- Share links for groups. One active invite is expected per group; regenerating
-- an invite revokes older active rows.
CREATE TABLE IF NOT EXISTS group_invites (
  token      text        PRIMARY KEY,
  group_id   text        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Prediction markets
CREATE TABLE IF NOT EXISTS markets (
  id                      text        PRIMARY KEY,
  group_id                text        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  question                text        NOT NULL,
  category                text        NOT NULL DEFAULT 'General',
  status                  text        NOT NULL DEFAULT 'open',
  mode                    text        NOT NULL DEFAULT 'fake',
  oracle_type             text        NOT NULL DEFAULT 'ai',
  probability             numeric     NOT NULL DEFAULT 0.5,
  pool_yes                numeric     NOT NULL DEFAULT 2500.0,
  pool_no                 numeric     NOT NULL DEFAULT 2500.0,
  k                       numeric     NOT NULL DEFAULT 6250000.0,
  initial_liquidity       numeric     NOT NULL DEFAULT 5000.0,
  total_bet               numeric     NOT NULL DEFAULT 0.0,
  yes_shares_outstanding  numeric     NOT NULL DEFAULT 0.0,
  no_shares_outstanding   numeric     NOT NULL DEFAULT 0.0,
  closes_at               timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  outcome                 text,
  resolved_at             timestamptz,
  oracle_proposal         jsonb
);

-- Trades
CREATE TABLE IF NOT EXISTS trades (
  id          text        PRIMARY KEY,
  market_id   text        NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  participant text        NOT NULL,
  side        text        NOT NULL,   -- 'yes' | 'no'
  amount      numeric     NOT NULL,
  shares      numeric     NOT NULL,
  prob_before numeric,
  prob_after  numeric,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Event-level market engine. New trades should use these tables; legacy
-- markets/trades remain for best-effort migration and compatibility only.
CREATE TABLE IF NOT EXISTS market_events (
  id              text        PRIMARY KEY,
  group_id        text        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title           text        NOT NULL,
  description     text        NOT NULL DEFAULT '',
  status          text        NOT NULL DEFAULT 'open',
  mode            text        NOT NULL DEFAULT 'fake',
  oracle_type     text        NOT NULL DEFAULT 'ai',
  liquidity_b     numeric     NOT NULL DEFAULT 20000.0,
  total_volume    numeric     NOT NULL DEFAULT 0.0,
  closes_at       timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  outcome_id      text,
  resolved_at     timestamptz,
  oracle_proposal jsonb,
  image_url       text,
  created_by      text,
  legacy_key      text,
  resolution_source text,
  edge_cases text,
  verification_status text NOT NULL DEFAULT 'not_started',
  verification_attempts jsonb NOT NULL DEFAULT '[]',
  resolved_by text,
  resolution_notes text
);

CREATE TABLE IF NOT EXISTS market_outcomes (
  id               text        PRIMARY KEY,
  event_id         text        NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  title            text        NOT NULL,
  sort_order       integer     NOT NULL DEFAULT 0,
  quantity         numeric     NOT NULL DEFAULT 0.0,
  price            numeric     NOT NULL DEFAULT 0.0,
  status           text        NOT NULL DEFAULT 'active',
  eliminated_at    timestamptz,
  eliminated_by    text,
  elimination_notes text,
  legacy_market_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, title)
);

CREATE TABLE IF NOT EXISTS event_positions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    text        NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  outcome_id  text        NOT NULL REFERENCES market_outcomes(id) ON DELETE CASCADE,
  participant text        NOT NULL,
  shares      numeric     NOT NULL DEFAULT 0.0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, outcome_id, participant)
);

CREATE TABLE IF NOT EXISTS event_trades (
  id            text        PRIMARY KEY,
  event_id      text        NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  outcome_id    text        NOT NULL REFERENCES market_outcomes(id) ON DELETE CASCADE,
  participant   text        NOT NULL,
  action        text        NOT NULL,
  cash_amount   numeric     NOT NULL,
  shares_delta  numeric     NOT NULL,
  avg_price     numeric     NOT NULL,
  prices_before jsonb       NOT NULL,
  prices_after  jsonb       NOT NULL,
  display_group_id text,
  display_outcome_id text,
  display_side text,
  display_shares numeric,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Submitted seasonal bracket entries. LocalStorage is only a draft cache;
-- signed-in entries should persist here.
CREATE TABLE IF NOT EXISTS bracket_entries (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id text       NOT NULL,
  participant  text       NOT NULL,
  user_email   text,
  picks        jsonb      NOT NULL DEFAULT '{}',
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, participant)
);

-- Seasonal table-prediction contests. LocalStorage remains only a draft cache;
-- signed-in submissions persist here and lock once the season starts.
CREATE TABLE IF NOT EXISTS season_predictions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_code   text        UNIQUE DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 10),
  challenge_id text       NOT NULL,
  participant  text       NOT NULL,
  user_email   text,
  ranking      jsonb      NOT NULL DEFAULT '[]',
  submitted_at timestamptz,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, participant)
);

ALTER TABLE season_predictions ADD COLUMN IF NOT EXISTS share_code text;
UPDATE season_predictions
SET share_code = left(replace(id::text, '-', ''), 10)
WHERE share_code IS NULL;
ALTER TABLE season_predictions
  ALTER COLUMN share_code SET DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 10);
CREATE UNIQUE INDEX IF NOT EXISTS season_predictions_share_code_idx
  ON season_predictions (share_code)
  WHERE share_code IS NOT NULL;

-- Reusable global challenges attached to individual friend groups. Entries stay
-- global per user; this table controls discovery and group-specific standings.
CREATE TABLE IF NOT EXISTS group_challenges (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     text        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  challenge_id text        NOT NULL,
  added_by     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, challenge_id)
);

-- Market settlement approvals. Founder + creator must agree before payout when
-- they are different people.
CREATE TABLE IF NOT EXISTS market_resolution_approvals (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   text       NOT NULL REFERENCES market_events(id) ON DELETE CASCADE,
  outcome_id text       NOT NULL,
  resolver   text       NOT NULL,
  role       text       NOT NULL DEFAULT 'admin',
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, resolver)
);

ALTER TABLE event_trades ADD COLUMN IF NOT EXISTS display_group_id text;
ALTER TABLE event_trades ADD COLUMN IF NOT EXISTS display_outcome_id text;
ALTER TABLE event_trades ADD COLUMN IF NOT EXISTS display_side text;
ALTER TABLE event_trades ADD COLUMN IF NOT EXISTS display_shares numeric;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS created_by text;

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id);
CREATE INDEX IF NOT EXISTS idx_group_invites_active ON group_invites(group_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_groups_created_by ON groups(created_by);
CREATE INDEX IF NOT EXISTS idx_markets_group       ON markets(group_id);
CREATE INDEX IF NOT EXISTS idx_trades_market       ON trades(market_id);
CREATE INDEX IF NOT EXISTS idx_market_events_group ON market_events(group_id);
CREATE INDEX IF NOT EXISTS idx_market_events_open ON market_events(group_id, closes_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_market_outcomes_event ON market_outcomes(event_id);
CREATE INDEX IF NOT EXISTS idx_market_outcomes_legacy ON market_outcomes(legacy_market_id);
CREATE INDEX IF NOT EXISTS idx_event_positions_event_participant ON event_positions(event_id, participant);
CREATE INDEX IF NOT EXISTS idx_event_trades_event ON event_trades(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bracket_entries_challenge ON bracket_entries(challenge_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_season_predictions_challenge ON season_predictions(challenge_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_challenges_group ON group_challenges(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_market_resolution_approvals_event ON market_resolution_approvals(event_id, created_at);
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS resolution_source text;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS edge_cases text;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'not_started';
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS verification_attempts jsonb NOT NULL DEFAULT '[]';
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS resolved_by text;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS resolution_notes text;
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS eliminated_at timestamptz;
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS eliminated_by text;
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS elimination_notes text;
ALTER TABLE market_events ALTER COLUMN liquidity_b SET DEFAULT 20000.0;
ALTER TABLE group_members ALTER COLUMN balance SET DEFAULT 100000.0;

-- Disable RLS for development (no auth yet)
ALTER TABLE groups        DISABLE ROW LEVEL SECURITY;
ALTER TABLE group_members DISABLE ROW LEVEL SECURITY;
ALTER TABLE group_invites DISABLE ROW LEVEL SECURITY;
ALTER TABLE markets       DISABLE ROW LEVEL SECURITY;
ALTER TABLE trades        DISABLE ROW LEVEL SECURITY;
ALTER TABLE market_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE market_outcomes DISABLE ROW LEVEL SECURITY;
ALTER TABLE event_positions DISABLE ROW LEVEL SECURITY;
ALTER TABLE event_trades DISABLE ROW LEVEL SECURITY;
ALTER TABLE bracket_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE season_predictions DISABLE ROW LEVEL SECURITY;
ALTER TABLE group_challenges DISABLE ROW LEVEL SECURITY;
ALTER TABLE market_resolution_approvals DISABLE ROW LEVEL SECURITY;

-- Grant full access to the anon/publishable key role
GRANT ALL ON groups        TO anon;
GRANT ALL ON group_members TO anon;
GRANT ALL ON group_invites TO anon;
GRANT ALL ON markets       TO anon;
GRANT ALL ON trades        TO anon;
GRANT ALL ON market_events TO anon;
GRANT ALL ON market_outcomes TO anon;
GRANT ALL ON event_positions TO anon;
GRANT ALL ON event_trades TO anon;
GRANT ALL ON bracket_entries TO anon;
GRANT ALL ON season_predictions TO anon;
GRANT ALL ON group_challenges TO anon;
GRANT ALL ON market_resolution_approvals TO anon;

CREATE OR REPLACE FUNCTION probable_reprice_event(p_event_id text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_b numeric;
  v_sum numeric;
BEGIN
  SELECT liquidity_b INTO v_b FROM market_events WHERE id = p_event_id;
  IF v_b IS NULL OR v_b <= 0 THEN
    RAISE EXCEPTION 'Event not found or invalid liquidity';
  END IF;

  UPDATE market_outcomes
  SET price = 0
  WHERE event_id = p_event_id
    AND COALESCE(status, 'active') = 'eliminated';

  SELECT SUM(EXP(quantity / v_b)) INTO v_sum
  FROM market_outcomes
  WHERE event_id = p_event_id
    AND COALESCE(status, 'active') <> 'eliminated';

  IF v_sum IS NULL OR v_sum <= 0 THEN
    RAISE EXCEPTION 'Event has no active outcomes';
  END IF;

  UPDATE market_outcomes
  SET price = ROUND((EXP(quantity / v_b) / v_sum)::numeric, 8)
  WHERE event_id = p_event_id
    AND COALESCE(status, 'active') <> 'eliminated';
END;
$$;

CREATE OR REPLACE FUNCTION place_event_trade(
  p_event_id text,
  p_outcome_id text,
  p_participant text,
  p_action text,
  p_cash_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_event market_events%ROWTYPE;
  v_balance numeric;
  v_b numeric;
  v_sum_exp numeric;
  v_outcome_exp numeric;
  v_cash numeric;
  v_curve_cash numeric;
  v_fee_rate numeric := 0.015;
  v_multiplier numeric;
  v_shares numeric;
  v_new_quantity numeric;
  v_held_shares numeric;
  v_max_cash numeric;
  v_prices_before jsonb;
  v_prices_after jsonb;
  v_trade_id text;
  v_avg_price numeric;
BEGIN
  v_cash := ROUND(p_cash_amount::numeric, 4);
  IF v_cash <= 0 THEN
    RAISE EXCEPTION 'Trade amount must be positive';
  END IF;

  SELECT * INTO v_event
  FROM market_events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Market not found';
  END IF;
  IF v_event.status <> 'open' THEN
    RAISE EXCEPTION 'Market is not open for trading';
  END IF;
  IF v_event.closes_at <= now() THEN
    UPDATE market_events SET status = 'closed' WHERE id = p_event_id;
    RAISE EXCEPTION 'Market is closed for trading';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM market_outcomes
    WHERE id = p_outcome_id
      AND event_id = p_event_id
      AND COALESCE(status, 'active') <> 'eliminated'
  ) THEN
    RAISE EXCEPTION 'Outcome not found';
  END IF;

  SELECT balance INTO v_balance
  FROM group_members
  WHERE group_id = v_event.group_id AND name = btrim(p_participant)
  FOR UPDATE;

  IF v_balance IS NULL THEN
    INSERT INTO group_members(group_id, name, balance)
    VALUES (v_event.group_id, btrim(p_participant), 100000.0)
    ON CONFLICT (group_id, name) DO NOTHING;
    SELECT balance INTO v_balance
    FROM group_members
    WHERE group_id = v_event.group_id AND name = btrim(p_participant)
    FOR UPDATE;
  END IF;

  IF lower(p_action) = 'buy' AND v_cash > v_balance THEN
    RAISE EXCEPTION '% only has $%', p_participant, ROUND(v_balance, 0);
  END IF;

  v_b := v_event.liquidity_b;
  SELECT jsonb_object_agg(id, price ORDER BY sort_order), SUM(EXP(quantity / v_b))
    INTO v_prices_before, v_sum_exp
  FROM market_outcomes
  WHERE event_id = p_event_id
    AND COALESCE(status, 'active') <> 'eliminated';

  SELECT EXP(quantity / v_b) INTO v_outcome_exp
  FROM market_outcomes
  WHERE id = p_outcome_id
    AND event_id = p_event_id
    AND COALESCE(status, 'active') <> 'eliminated';

  IF lower(p_action) = 'buy' THEN
    v_curve_cash := ROUND(v_cash * (1 - v_fee_rate), 4);
    v_multiplier := EXP(v_curve_cash / v_b);
    v_shares := v_b * LN(1 + (v_sum_exp / v_outcome_exp) * (v_multiplier - 1));
    v_new_quantity := (SELECT quantity FROM market_outcomes WHERE id = p_outcome_id) + v_shares;
    UPDATE group_members
    SET balance = ROUND(balance - v_cash, 2)
    WHERE group_id = v_event.group_id AND name = btrim(p_participant);
  ELSIF lower(p_action) = 'sell' THEN
    SELECT COALESCE(shares, 0) INTO v_held_shares
    FROM event_positions
    WHERE event_id = p_event_id AND outcome_id = p_outcome_id AND participant = btrim(p_participant)
    FOR UPDATE;

    IF v_held_shares IS NULL THEN
      v_held_shares := 0;
    END IF;

    v_max_cash := (v_b * LN(v_sum_exp / (v_sum_exp - v_outcome_exp + v_outcome_exp * EXP(-v_held_shares / v_b)))) * (1 - v_fee_rate);
    IF v_cash > v_max_cash + 0.0001 THEN
      RAISE EXCEPTION '% does not have enough shares to sell for $%', p_participant, ROUND(v_cash, 2);
    END IF;

    v_curve_cash := ROUND(v_cash / (1 - v_fee_rate), 4);
    v_multiplier := EXP(v_curve_cash / v_b);
    IF (v_sum_exp / v_multiplier - (v_sum_exp - v_outcome_exp)) <= 0 THEN
      RAISE EXCEPTION 'Not enough liquidity to sell that much';
    END IF;
    v_shares := -v_b * LN((v_sum_exp / v_multiplier - (v_sum_exp - v_outcome_exp)) / v_outcome_exp);
    IF v_shares > v_held_shares + 0.0001 THEN
      RAISE EXCEPTION '% does not have enough shares to sell', p_participant;
    END IF;
    v_new_quantity := (SELECT quantity FROM market_outcomes WHERE id = p_outcome_id) - v_shares;
    v_shares := -v_shares;
    UPDATE group_members
    SET balance = ROUND(balance + v_cash, 2)
    WHERE group_id = v_event.group_id AND name = btrim(p_participant);
  ELSE
    RAISE EXCEPTION 'Unsupported trade action';
  END IF;

  UPDATE market_outcomes
  SET quantity = ROUND(v_new_quantity, 8)
  WHERE id = p_outcome_id AND event_id = p_event_id;

  PERFORM probable_reprice_event(p_event_id);

  INSERT INTO event_positions(event_id, outcome_id, participant, shares, updated_at)
  VALUES (p_event_id, p_outcome_id, btrim(p_participant), ROUND(v_shares, 8), now())
  ON CONFLICT (event_id, outcome_id, participant)
  DO UPDATE SET
    shares = ROUND(event_positions.shares + EXCLUDED.shares, 8),
    updated_at = now();

  SELECT jsonb_object_agg(id, price ORDER BY sort_order) INTO v_prices_after
  FROM market_outcomes
  WHERE event_id = p_event_id;

  v_trade_id := SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 8);
  v_avg_price := CASE WHEN ABS(v_shares) > 0 THEN ROUND((v_cash / ABS(v_shares))::numeric, 8) ELSE 0 END;

  INSERT INTO event_trades(
    id, event_id, outcome_id, participant, action, cash_amount, shares_delta,
    avg_price, prices_before, prices_after
  ) VALUES (
    v_trade_id, p_event_id, p_outcome_id, btrim(p_participant), lower(p_action),
    v_cash, ROUND(v_shares, 8), v_avg_price, v_prices_before, v_prices_after
  );

  UPDATE market_events
  SET total_volume = ROUND(total_volume + v_cash, 4)
  WHERE id = p_event_id;

  RETURN jsonb_build_object(
    'tradeId', v_trade_id,
    'eventId', p_event_id,
    'outcomeId', p_outcome_id,
    'sharesDelta', ROUND(v_shares, 8),
    'avgPrice', v_avg_price,
    'cashAmount', v_cash,
    'feeRate', v_fee_rate,
    'fee', ROUND(CASE WHEN lower(p_action) = 'buy' THEN v_cash * v_fee_rate ELSE v_curve_cash - v_cash END, 4),
    'curveCash', ROUND(v_curve_cash, 4),
    'pricesBefore', v_prices_before,
    'pricesAfter', v_prices_after
  );
END;
$$;

CREATE OR REPLACE FUNCTION resolve_event_market(
  p_event_id text,
  p_outcome_id text,
  p_resolved_by text DEFAULT 'manual',
  p_resolution_notes text DEFAULT NULL,
  p_oracle_proposal jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_event market_events%ROWTYPE;
  v_outcome market_outcomes%ROWTYPE;
  v_resolved_by text;
  v_notes text;
  v_resolved_at timestamptz;
  v_payouts jsonb;
  v_total_paid numeric;
BEGIN
  SELECT * INTO v_event
  FROM market_events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Market not found';
  END IF;

  IF v_event.status = 'open' AND v_event.closes_at <= now() THEN
    UPDATE market_events SET status = 'closed' WHERE id = p_event_id;
    v_event.status := 'closed';
  END IF;

  IF v_event.status = 'resolved' THEN
    RAISE EXCEPTION 'Already resolved';
  END IF;

  IF v_event.status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'Market must be open or closed before resolution';
  END IF;

  SELECT * INTO v_outcome
  FROM market_outcomes
  WHERE id = p_outcome_id AND event_id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resolution outcome not found';
  END IF;
  IF COALESCE(v_outcome.status, 'active') = 'eliminated' THEN
    RAISE EXCEPTION 'Cannot resolve to an eliminated outcome';
  END IF;

  v_resolved_by := COALESCE(NULLIF(btrim(p_resolved_by), ''), 'manual');
  v_notes := NULLIF(btrim(COALESCE(p_resolution_notes, '')), '');
  IF v_notes IS NULL THEN
    v_notes := 'Manually resolved to ' || v_outcome.title || '.';
  END IF;
  v_resolved_at := now();

  PERFORM 1
  FROM group_members gm
  WHERE gm.group_id = v_event.group_id
    AND EXISTS (
      SELECT 1
      FROM event_positions ep
      WHERE ep.event_id = p_event_id
        AND ep.outcome_id = p_outcome_id
        AND ep.participant = gm.name
        AND ep.shares > 0
    )
  ORDER BY gm.name
  FOR UPDATE;

  WITH winning_positions AS (
    SELECT participant, ROUND(SUM(shares), 8) AS shares
    FROM event_positions
    WHERE event_id = p_event_id
      AND outcome_id = p_outcome_id
    GROUP BY participant
    HAVING SUM(shares) > 0
  ),
  credited AS (
    UPDATE group_members gm
    SET balance = ROUND(gm.balance + wp.shares, 2)
    FROM winning_positions wp
    WHERE gm.group_id = v_event.group_id
      AND gm.name = wp.participant
    RETURNING wp.participant, wp.shares, gm.balance
  )
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'participant', participant,
          'shares', shares,
          'payout', ROUND(shares, 2),
          'balanceAfter', balance
        )
        ORDER BY participant
      ),
      '[]'::jsonb
    ),
    COALESCE(SUM(shares), 0)
  INTO v_payouts, v_total_paid
  FROM credited;

  UPDATE market_events
  SET status = 'resolved',
      outcome_id = p_outcome_id,
      resolved_at = v_resolved_at,
      resolved_by = v_resolved_by,
      verification_status = 'resolved',
      resolution_notes = LEFT(v_notes, 1200),
      oracle_proposal = COALESCE(p_oracle_proposal, oracle_proposal)
  WHERE id = p_event_id;

  RETURN jsonb_build_object(
    'eventId', p_event_id,
    'outcomeId', p_outcome_id,
    'outcomeTitle', v_outcome.title,
    'resolvedBy', v_resolved_by,
    'resolutionNotes', LEFT(v_notes, 1200),
    'resolvedAt', v_resolved_at,
    'payouts', v_payouts,
    'totalPaid', ROUND(v_total_paid, 2)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_event_market(text, text, text, text, jsonb) TO anon;

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

ALTER TABLE market_events ADD COLUMN IF NOT EXISTS catalog_market_id text;
CREATE INDEX IF NOT EXISTS market_catalog_status_category_idx ON market_catalog (status, category, featured DESC);
CREATE INDEX IF NOT EXISTS market_events_catalog_market_id_idx ON market_events (catalog_market_id) WHERE catalog_market_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS market_events_group_catalog_unique_idx ON market_events (group_id, catalog_market_id) WHERE catalog_market_id IS NOT NULL;
ALTER TABLE market_catalog DISABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE market_catalog TO anon;
