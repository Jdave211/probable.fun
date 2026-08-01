-- Short, durable public links for submitted league-table predictions.
ALTER TABLE season_predictions ADD COLUMN IF NOT EXISTS share_code text;

UPDATE season_predictions
SET share_code = left(replace(id::text, '-', ''), 10)
WHERE share_code IS NULL;

ALTER TABLE season_predictions
  ALTER COLUMN share_code SET DEFAULT left(replace(gen_random_uuid()::text, '-', ''), 10);

CREATE UNIQUE INDEX IF NOT EXISTS season_predictions_share_code_idx
  ON season_predictions (share_code)
  WHERE share_code IS NOT NULL;
