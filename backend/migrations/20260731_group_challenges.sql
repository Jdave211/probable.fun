CREATE TABLE IF NOT EXISTS group_challenges (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     text        NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  challenge_id text        NOT NULL,
  added_by     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_group_challenges_group
  ON group_challenges(group_id, created_at);

ALTER TABLE group_challenges DISABLE ROW LEVEL SECURITY;
GRANT ALL ON group_challenges TO anon;
