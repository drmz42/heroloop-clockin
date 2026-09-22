/*
# Tokenomics tables: players, token_pool, distribution_log

Creates the three core tables for the 1B $HERO tokenomics system.
*/

-- ── players ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username       text   NOT NULL DEFAULT 'player',
  power          bigint NOT NULL DEFAULT 0,
  account_level  int    NOT NULL DEFAULT 1,
  online         boolean NOT NULL DEFAULT false,
  last_heartbeat timestamptz DEFAULT now(),
  pending_tokens numeric NOT NULL DEFAULT 0,
  total_claimed  numeric NOT NULL DEFAULT 0,
  updated_at     timestamptz DEFAULT now()
);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_player" ON players;
CREATE POLICY "select_own_player" ON players FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_player" ON players;
CREATE POLICY "insert_own_player" ON players FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "update_own_player" ON players;
CREATE POLICY "update_own_player" ON players FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── token_pool (singleton) ───────────────────────────────
CREATE TABLE IF NOT EXISTS token_pool (
  id                 int PRIMARY KEY DEFAULT 1,
  pool_amount        numeric NOT NULL DEFAULT 0,
  total_distributed  numeric NOT NULL DEFAULT 0,
  distribution_rate  numeric NOT NULL DEFAULT 0.15,
  updated_at         timestamptz DEFAULT now(),
  CONSTRAINT singleton CHECK (id = 1)
);

ALTER TABLE token_pool ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_token_pool" ON token_pool;
CREATE POLICY "read_token_pool" ON token_pool FOR SELECT
  TO anon, authenticated USING (true);

-- ── distribution_log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS distribution_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_at            timestamptz NOT NULL DEFAULT now(),
  total_power        bigint NOT NULL DEFAULT 0,
  player_count       int NOT NULL DEFAULT 0,
  amount_distributed numeric NOT NULL DEFAULT 0,
  interval_seconds   int NOT NULL DEFAULT 60
);

ALTER TABLE distribution_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_distribution_log" ON distribution_log;
CREATE POLICY "read_distribution_log" ON distribution_log FOR SELECT
  TO anon, authenticated USING (true);

-- ── Initialize the singleton pool row ────────────────────
INSERT INTO token_pool (id, pool_amount, total_distributed, distribution_rate)
VALUES (1, 0, 0, 0.15)
ON CONFLICT (id) DO NOTHING;

-- ── Index for online-player queries ──────────────────────
CREATE INDEX IF NOT EXISTS idx_players_online ON players(online) WHERE online = true;
CREATE INDEX IF NOT EXISTS idx_players_heartbeat ON players(last_heartbeat);