BEGIN;

ALTER TABLE public.event_trades ADD COLUMN IF NOT EXISTS display_group_id text;
ALTER TABLE public.event_trades ADD COLUMN IF NOT EXISTS display_outcome_id text;
ALTER TABLE public.event_trades ADD COLUMN IF NOT EXISTS display_side text;
ALTER TABLE public.event_trades ADD COLUMN IF NOT EXISTS display_shares numeric;

-- A NO basket buys the same number of shares in every other active outcome.
-- Lock the event, then the account, just like the single-outcome trade RPC.
-- All prices, positions, cash and history commit together or roll back together.
CREATE OR REPLACE FUNCTION public.place_complement_event_trade_for_user(
  p_event_id text, p_outcome_id text, p_action text,
  p_cash_amount numeric, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_event market_events%ROWTYPE;
  v_member group_members%ROWTYPE;
  v_cash numeric := ROUND(p_cash_amount, 2);
  v_curve_cash numeric;
  v_b numeric;
  v_max_q numeric;
  v_sum numeric;
  v_target numeric;
  v_complement numeric;
  v_ratio numeric;
  v_shares numeric;
  v_delta numeric;
  v_held numeric;
  v_max_cash numeric;
  v_count integer;
  v_before jsonb;
  v_after jsonb;
  v_group_id text := REPLACE(gen_random_uuid()::text, '-', '');
  v_rows jsonb := '[]'::jsonb;
  v_row jsonb;
  v_outcome record;
  v_index integer := 0;
  v_allocated numeric;
  v_remaining numeric;
  v_weight numeric;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Authenticated user is required'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('buy', 'sell') THEN RAISE EXCEPTION 'Unsupported trade action'; END IF;
  IF v_cash IS NULL OR v_cash::text IN ('NaN', 'Infinity', '-Infinity') OR v_cash <= 0 OR v_cash > 1000000 THEN
    RAISE EXCEPTION 'Enter a trade amount between 0.01 and 1000000';
  END IF;
  IF p_cash_amount <> v_cash THEN RAISE EXCEPTION 'Trade amounts must use whole cents'; END IF;

  SELECT * INTO v_event FROM market_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Market not found'; END IF;
  IF v_event.status <> 'open' OR v_event.closes_at <= now() THEN RAISE EXCEPTION 'Market is closed for trading'; END IF;
  v_b := v_event.liquidity_b;
  IF v_b IS NULL OR v_b <= 0 THEN RAISE EXCEPTION 'Invalid market liquidity'; END IF;
  IF p_action = 'buy' AND v_cash > v_b / 2 THEN RAISE EXCEPTION 'Trade exceeds the single-trade limit'; END IF;

  SELECT * INTO v_member FROM group_members
  WHERE group_id = v_event.group_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Join this group before trading'; END IF;
  IF NOT EXISTS (SELECT 1 FROM market_outcomes WHERE id = p_outcome_id AND event_id = p_event_id AND status <> 'eliminated') THEN
    RAISE EXCEPTION 'Outcome not found or eliminated';
  END IF;
  SELECT count(*), MAX(quantity) INTO v_count, v_max_q FROM market_outcomes
  WHERE event_id = p_event_id AND status <> 'eliminated';
  IF v_count < 2 THEN RAISE EXCEPTION 'Market needs two active outcomes'; END IF;
  SELECT SUM(EXP((quantity - v_max_q) / v_b)),
         SUM(EXP((quantity - v_max_q) / v_b)) FILTER (WHERE id = p_outcome_id)
  INTO v_sum, v_target FROM market_outcomes WHERE event_id = p_event_id AND status <> 'eliminated';
  v_complement := v_sum - v_target;
  SELECT jsonb_object_agg(id, price) INTO v_before FROM market_outcomes WHERE event_id = p_event_id;

  IF p_action = 'buy' THEN
    IF v_cash > v_member.balance THEN RAISE EXCEPTION 'Not enough balance for this trade'; END IF;
    v_curve_cash := v_cash * 0.985;
    v_shares := v_b * LN((v_sum * EXP(v_curve_cash / v_b) - v_target) / v_complement);
    v_delta := ROUND(v_shares, 8);
  ELSE
    SELECT MIN(COALESCE(ep.shares, 0)) INTO v_held
    FROM market_outcomes mo LEFT JOIN event_positions ep
      ON ep.event_id = mo.event_id AND ep.outcome_id = mo.id AND ep.user_id = p_user_id
    WHERE mo.event_id = p_event_id AND mo.id <> p_outcome_id AND mo.status <> 'eliminated';
    v_max_cash := v_b * LN(v_sum / (v_target + v_complement * EXP(-v_held / v_b))) * 0.985;
    IF v_cash > v_max_cash + 0.00000001 THEN RAISE EXCEPTION 'Not enough NO shares to sell'; END IF;
    v_curve_cash := v_cash / 0.985;
    v_ratio := (v_sum * EXP(-v_curve_cash / v_b) - v_target) / v_complement;
    IF v_ratio <= 0 THEN RAISE EXCEPTION 'Not enough market liquidity'; END IF;
    v_shares := -v_b * LN(v_ratio);
    IF v_shares > v_held + 0.00000001 THEN RAISE EXCEPTION 'Not enough NO shares to sell'; END IF;
    v_delta := -ROUND(v_shares, 8);
  END IF;

  UPDATE market_outcomes SET quantity = ROUND(quantity + v_delta, 8)
  WHERE event_id = p_event_id AND id <> p_outcome_id AND status <> 'eliminated';
  UPDATE group_members SET balance = ROUND(balance + CASE WHEN p_action = 'buy' THEN -v_cash ELSE v_cash END, 2)
  WHERE id = v_member.id;
  INSERT INTO event_positions(event_id, outcome_id, participant, user_id, shares, updated_at)
  SELECT p_event_id, id, v_member.name, p_user_id, v_delta, now() FROM market_outcomes
  WHERE event_id = p_event_id AND id <> p_outcome_id AND status <> 'eliminated'
  ON CONFLICT (event_id, outcome_id, participant) DO UPDATE
  SET shares = ROUND(event_positions.shares + EXCLUDED.shares, 8), user_id = EXCLUDED.user_id, updated_at = now();

  PERFORM probable_reprice_event(p_event_id);
  SELECT jsonb_object_agg(id, price) INTO v_after FROM market_outcomes WHERE event_id = p_event_id;
  v_remaining := v_cash;
  SELECT SUM(GREATEST(0.000001, (v_before->>id)::numeric)) INTO v_weight
  FROM market_outcomes WHERE event_id = p_event_id AND id <> p_outcome_id AND status <> 'eliminated';
  FOR v_outcome IN SELECT id FROM market_outcomes
    WHERE event_id = p_event_id AND id <> p_outcome_id AND status <> 'eliminated' ORDER BY sort_order, id
  LOOP
    v_index := v_index + 1;
    v_allocated := CASE WHEN v_index = v_count - 1 THEN v_remaining
      ELSE ROUND(v_cash * GREATEST(0.000001, (v_before->>v_outcome.id)::numeric) / v_weight, 4) END;
    v_remaining := v_remaining - v_allocated;
    INSERT INTO event_trades(id, event_id, outcome_id, participant, user_id, action, cash_amount, shares_delta,
      avg_price, prices_before, prices_after, display_group_id, display_outcome_id, display_side, display_shares)
    VALUES(REPLACE(gen_random_uuid()::text, '-', ''), p_event_id, v_outcome.id, v_member.name, p_user_id, p_action,
      v_allocated, v_delta, ROUND(v_cash / v_shares, 8), v_before, v_after, v_group_id, p_outcome_id, 'no', ROUND(v_shares, 8))
    RETURNING to_jsonb(event_trades.*) INTO v_row;
    v_rows := v_rows || jsonb_build_array(v_row);
  END LOOP;
  UPDATE market_events SET total_volume = total_volume + v_cash WHERE id = p_event_id;
  RETURN jsonb_build_object('basket', true, 'synthetic', 'complement_no', 'selectedOutcomeId', p_outcome_id,
    'shares', ROUND(v_shares, 8), 'amount', v_cash, 'trades', v_rows);
END;
$$;

-- Deployment health checks must detect missing RPCs and open browser access.
CREATE OR REPLACE FUNCTION public.probable_production_readiness()
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_table text;
  v_function record;
BEGIN
  IF to_regprocedure('public.place_complement_event_trade_for_user(text,text,text,numeric,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Production trade migration is missing';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['groups','group_members','group_invites','markets','trades','market_events',
    'market_outcomes','event_positions','event_trades','bracket_entries','season_predictions','group_challenges',
    'market_resolution_approvals','market_catalog']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || v_table) AND relrowsecurity) THEN
      RAISE EXCEPTION 'Row security is missing on %', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE')
      OR has_table_privilege('authenticated', 'public.' || v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Browser data access has not been locked down on %', v_table;
    END IF;
  END LOOP;
  FOR v_function IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('probable_reprice_event','place_event_trade',
      'place_event_trade_for_user','place_complement_event_trade_for_user','resolve_event_market')
  LOOP
    IF has_function_privilege('anon', v_function.oid, 'EXECUTE') OR has_function_privilege('authenticated', v_function.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Browser trading RPC access has not been locked down';
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ready', true, 'schemaVersion', '20260909');
END;
$$;

DO $$
DECLARE v_table text; v_function record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['groups','group_members','group_invites','markets','trades','market_events',
    'market_outcomes','event_positions','event_trades','bracket_entries','season_predictions','group_challenges',
    'market_resolution_approvals','market_catalog']
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table);
  END LOOP;
  FOR v_function IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('probable_reprice_event','place_event_trade',
      'place_event_trade_for_user','place_complement_event_trade_for_user','resolve_event_market','probable_production_readiness')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_function.signature);
  END LOOP;
END;
$$;

COMMIT;
