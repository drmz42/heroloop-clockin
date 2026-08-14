\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS heroloop_api AUTHORIZATION supabase_admin;
REVOKE ALL ON SCHEMA heroloop_api FROM PUBLIC;
GRANT USAGE ON SCHEMA heroloop_api TO heroloop_api;

CREATE OR REPLACE FUNCTION heroloop_api.account_status(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'exists', EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id),
    'username', (SELECT username FROM public.players WHERE player_id = p_player_id),
    'account_id', p_player_id
  )
$function$;

REVOKE ALL ON FUNCTION heroloop_api.account_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.account_status(uuid) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.account_status(uuid) IS
  'Read-only v1 account-status adapter; caller identity must come from the verified JWT subject.';
