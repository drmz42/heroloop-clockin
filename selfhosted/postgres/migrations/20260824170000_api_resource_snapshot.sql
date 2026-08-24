CREATE OR REPLACE FUNCTION heroloop_api.resource_snapshot(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$ SELECT public.resource_snapshot(p_player_id) $function$;
REVOKE ALL ON FUNCTION heroloop_api.resource_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.resource_snapshot(uuid) TO heroloop_api;
