ALTER TABLE players
  ADD COLUMN IF NOT EXISTS total_kills bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS boss_kills bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chests_opened bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heroes_owned int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS highest_location int NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_players_leaderboard
  ON players(account_level DESC, total_kills DESC, power DESC);
