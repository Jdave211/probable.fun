-- Outcome elimination for multi-outcome markets.
-- Lets admins mark one outcome impossible without resolving the whole event.

ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS eliminated_at timestamptz;
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS eliminated_by text;
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS elimination_notes text;

CREATE INDEX IF NOT EXISTS idx_market_outcomes_event_active
  ON market_outcomes(event_id, sort_order)
  WHERE COALESCE(status, 'active') <> 'eliminated';

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
    RETURNING gm.name AS participant, wp.shares, gm.balance AS balance_after
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'participant', participant,
      'shares', shares,
      'payout', ROUND(shares, 2),
      'balanceAfter', balance_after
    ) ORDER BY participant), '[]'::jsonb),
    COALESCE(SUM(ROUND(shares, 2)), 0)
  INTO v_payouts, v_total_paid
  FROM credited;

  UPDATE market_events
  SET status = 'resolved',
      outcome_id = p_outcome_id,
      resolved_at = v_resolved_at,
      oracle_proposal = COALESCE(p_oracle_proposal, oracle_proposal),
      verification_status = 'resolved',
      resolved_by = v_resolved_by,
      resolution_notes = v_notes
  WHERE id = p_event_id;

  RETURN jsonb_build_object(
    'eventId', p_event_id,
    'outcomeId', p_outcome_id,
    'outcomeTitle', v_outcome.title,
    'resolvedBy', v_resolved_by,
    'resolutionNotes', v_notes,
    'resolvedAt', v_resolved_at,
    'payouts', v_payouts,
    'totalPaid', ROUND(v_total_paid, 2)
  );
END;
$$;
