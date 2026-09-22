/*
# Recreate players with an auth-linked player_id

Player identity is the verified Supabase Auth user id. Wallet presentation
must not replace the authenticated database identity.
*/

-- Drop the prototype table and recreate with the final auth-linked key.
DROP TABLE IF EXISTS players CASCADE;

CREATE TABLE players (
  player_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
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

-- Prototype policies are removed by the later security-lockdown migration.
DROP POLICY IF EXISTS "anon_read_players" ON players;
CREATE POLICY "anon_read_players" ON players FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_players" ON players;
CREATE POLICY "anon_insert_players" ON players FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_players" ON players;
CREATE POLICY "anon_update_players" ON players FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_players" ON players;
CREATE POLICY "anon_delete_players" ON players FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_players_online ON players(online) WHERE online = true;
CREATE INDEX IF NOT EXISTS idx_players_heartbeat ON players(last_heartbeat);
