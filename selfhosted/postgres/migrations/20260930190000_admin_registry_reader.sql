-- Registry history filters and orders by player; avoid a full ledger scan.
SET lock_timeout = '3s';
CREATE INDEX IF NOT EXISTS hero_economy_ledger_player_occurred_idx
  ON public.hero_economy_ledger (player_id, occurred_at DESC, id DESC);
RESET lock_timeout;

-- Separate capability for the optional Production connection. No login, no
-- membership of the broad admin role, no direct table or helper grants.
DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heroloop_registry_reader') THEN
    CREATE ROLE heroloop_registry_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$block$;
GRANT USAGE ON SCHEMA admin TO heroloop_registry_reader;
GRANT EXECUTE ON FUNCTION admin.game_registry_items(jsonb),
  admin.game_registry_heroes(jsonb), admin.game_registry_accounts(jsonb),
  admin.game_registry_player(uuid) TO heroloop_registry_reader;
