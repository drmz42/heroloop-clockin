CREATE OR REPLACE FUNCTION heroloop_api.summon_boss(p_player_id uuid, p_location integer, p_idempotency_key uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT to_jsonb(result) FROM public.summon_boss(p_player_id, p_location, p_idempotency_key) result
$function$;
REVOKE ALL ON FUNCTION heroloop_api.summon_boss(uuid, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.summon_boss(uuid, integer) FROM PUBLIC, heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.summon_boss(uuid, integer, uuid) TO heroloop_api;
