\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_gold(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.credit_tester_gold(p_player_id, 10000)
$function$;

REVOKE ALL ON FUNCTION heroloop_api.tester_credit_gold(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.tester_credit_gold(uuid) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.tester_credit_gold(uuid) IS
  'Staging-only fixed 10,000-Gold transport fixture; the API environment gate rejects it elsewhere.';
