-- SECURITY LOCKDOWN
-- The previous prototype migration intentionally allowed anonymous CRUD on
-- every player row. That is unacceptable for an internet-accessible build.

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_players" ON players;
DROP POLICY IF EXISTS "anon_insert_players" ON players;
DROP POLICY IF EXISTS "anon_update_players" ON players;
DROP POLICY IF EXISTS "anon_delete_players" ON players;
DROP POLICY IF EXISTS "select_own_player" ON players;
DROP POLICY IF EXISTS "insert_own_player" ON players;
DROP POLICY IF EXISTS "update_own_player" ON players;

REVOKE ALL ON TABLE players FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE players FROM authenticated;

-- Authenticated users may only read the row keyed by their Supabase auth id.
-- All writes remain server-only through the service role until authoritative
-- combat/state validation is implemented.
CREATE POLICY "authenticated_read_own_player"
  ON players FOR SELECT
  TO authenticated
  USING (player_id = auth.uid());

-- Pool totals can remain publicly visible, but the distribution log exposes
-- operational data and is restricted to authenticated users.
DROP POLICY IF EXISTS "read_distribution_log" ON distribution_log;
CREATE POLICY "authenticated_read_distribution_log"
  ON distribution_log FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON TABLE distribution_log FROM anon;
GRANT SELECT ON TABLE distribution_log TO authenticated;
