-- Apply after schema.sql and the production integrity migration.
-- Browser clients use Supabase Auth; application data goes through the API.
BEGIN;
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
