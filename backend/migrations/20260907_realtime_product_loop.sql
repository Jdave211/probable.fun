-- Keep the product live without page reloads. RLS remains the authority for
-- which rows an authenticated client is allowed to receive.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'market_events',
    'market_outcomes',
    'event_trades',
    'event_positions',
    'group_members',
    'season_predictions',
    'market_resolution_approvals'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = table_name
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
    END IF;
  END LOOP;
END $$;
