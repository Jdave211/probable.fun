-- Probable public-launch Supabase lockdown.
--
-- Run this only after the deployed FastAPI backend is configured with
-- SUPABASE_SERVICE_ROLE_KEY. The frontend should use Supabase Auth only; all
-- app data reads/writes should go through the backend.

REVOKE ALL ON groups FROM anon, authenticated;
REVOKE ALL ON group_members FROM anon, authenticated;
REVOKE ALL ON group_invites FROM anon, authenticated;
REVOKE ALL ON markets FROM anon, authenticated;
REVOKE ALL ON trades FROM anon, authenticated;
REVOKE ALL ON market_events FROM anon, authenticated;
REVOKE ALL ON market_outcomes FROM anon, authenticated;
REVOKE ALL ON event_positions FROM anon, authenticated;
REVOKE ALL ON event_trades FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION probable_reprice_event(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION place_event_trade(text, text, text, text, numeric) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION resolve_event_market(text, text, text, text, jsonb) FROM anon, authenticated;

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_trades ENABLE ROW LEVEL SECURITY;
