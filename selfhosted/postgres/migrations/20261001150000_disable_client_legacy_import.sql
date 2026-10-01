-- Browser legacy imports are disabled: missing saves require reviewed recovery.
-- Existing saves remain idempotently readable; no player rows or values change.
BEGIN;
CREATE OR REPLACE FUNCTION heroloop_api.game_state_migrate(p_player_id uuid, p_state jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_save public.player_saves%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_account_required'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_legacy_import_disabled'; END IF;
  RETURN jsonb_build_object('state', v_save.state, 'revision', v_save.revision, 'migrated', false);
END
$function$;
REVOKE ALL ON FUNCTION heroloop_api.game_state_migrate(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.game_state_migrate(uuid, jsonb) TO heroloop_api;
COMMENT ON FUNCTION heroloop_api.game_state_migrate(uuid, jsonb) IS
  'Returns an existing canonical save only; browser-created legacy saves are disabled.';
COMMIT;
