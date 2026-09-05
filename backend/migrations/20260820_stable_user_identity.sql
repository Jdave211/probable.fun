-- Stable Supabase identity for memberships, balances, positions, permissions,
-- and prediction entries. Display names remain snapshots for presentation.

ALTER TABLE groups ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS resolved_by_user_id uuid;
ALTER TABLE market_outcomes ADD COLUMN IF NOT EXISTS eliminated_by_user_id uuid;
ALTER TABLE event_positions ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE event_trades ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE bracket_entries ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE season_predictions ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE group_challenges ADD COLUMN IF NOT EXISTS added_by_user_id uuid;
ALTER TABLE market_resolution_approvals ADD COLUMN IF NOT EXISTS resolver_user_id uuid;

-- Verified email rows can be migrated without guessing from display names.
UPDATE group_members gm
SET user_id = users.id
FROM auth.users AS users
WHERE gm.user_id IS NULL
  AND users.email IS NOT NULL
  AND lower(gm.name) = lower(users.email);

UPDATE bracket_entries entry
SET user_id = users.id
FROM auth.users AS users
WHERE entry.user_id IS NULL
  AND entry.user_email IS NOT NULL
  AND users.email IS NOT NULL
  AND lower(entry.user_email) = lower(users.email);

UPDATE season_predictions entry
SET user_id = users.id
FROM auth.users AS users
WHERE entry.user_id IS NULL
  AND entry.user_email IS NOT NULL
  AND users.email IS NOT NULL
  AND lower(entry.user_email) = lower(users.email);

UPDATE groups g
SET created_by_user_id = gm.user_id
FROM group_members gm
WHERE g.created_by_user_id IS NULL
  AND gm.group_id = g.id
  AND gm.user_id IS NOT NULL
  AND lower(gm.name) = lower(g.created_by);

UPDATE market_events event
SET created_by_user_id = gm.user_id
FROM group_members gm
WHERE event.created_by_user_id IS NULL
  AND gm.group_id = event.group_id
  AND gm.user_id IS NOT NULL
  AND lower(gm.name) = lower(event.created_by);

UPDATE event_positions position
SET user_id = gm.user_id
FROM market_events event, group_members gm
WHERE position.user_id IS NULL
  AND event.id = position.event_id
  AND gm.group_id = event.group_id
  AND gm.user_id IS NOT NULL
  AND gm.name = position.participant;

UPDATE event_trades trade
SET user_id = gm.user_id
FROM market_events event, group_members gm
WHERE trade.user_id IS NULL
  AND event.id = trade.event_id
  AND gm.group_id = event.group_id
  AND gm.user_id IS NOT NULL
  AND gm.name = trade.participant;

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_group_user
  ON group_members(group_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_created_by_user
  ON groups(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_positions_event_outcome_user
  ON event_positions(event_id, outcome_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_trades_user
  ON event_trades(user_id, created_at) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bracket_entries_challenge_user
  ON bracket_entries(challenge_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_season_predictions_challenge_user
  ON season_predictions(challenge_id, user_id) WHERE user_id IS NOT NULL;

-- Keep the proven market math in place while binding its inputs and outputs to
-- the authenticated membership in a single database transaction.
CREATE OR REPLACE FUNCTION place_event_trade_for_user(
  p_event_id text,
  p_outcome_id text,
  p_participant text,
  p_action text,
  p_cash_amount numeric,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_event market_events%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_event FROM market_events WHERE id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Market not found';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Authenticated user is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_event.group_id
      AND user_id = p_user_id
      AND name = btrim(p_participant)
  ) THEN
    RAISE EXCEPTION 'Join this group before trading';
  END IF;

  v_result := place_event_trade(
    p_event_id,
    p_outcome_id,
    p_participant,
    p_action,
    p_cash_amount
  );

  UPDATE event_positions
  SET user_id = p_user_id
  WHERE event_id = p_event_id
    AND outcome_id = p_outcome_id
    AND participant = btrim(p_participant)
    AND user_id IS NULL;

  UPDATE event_trades
  SET user_id = p_user_id
  WHERE id = v_result->>'tradeId';

  RETURN v_result;
END;
$$;
