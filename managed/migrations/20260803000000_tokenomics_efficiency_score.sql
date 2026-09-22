-- Efficiency-weighted $HERO distribution score (approved 2026-08-03).
-- playerScore = effectivePower x (1 + 0.10 x (highest_location - 1)).
-- Persist training occupancy so the forfeited share can be accounted and logged.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS training_hero_count int NOT NULL DEFAULT 0;

ALTER TABLE distribution_log
  ADD COLUMN IF NOT EXISTS forfeited numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score_version int NOT NULL DEFAULT 1;
