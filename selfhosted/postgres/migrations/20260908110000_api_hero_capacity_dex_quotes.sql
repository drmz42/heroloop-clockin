\set ON_ERROR_STOP on

DROP FUNCTION heroloop_api.hero_capacity_upgrade(uuid,uuid,bigint);
CREATE FUNCTION heroloop_api.hero_capacity_quote(p_player_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
  SELECT public.quote_hero_capacity_upgrade(p_player_id,p_expected_revision)
$function$;
CREATE FUNCTION heroloop_api.hero_capacity_upgrade(
  p_player_id uuid,p_idempotency_key uuid,p_expected_revision bigint,p_quote_id uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
  SELECT public.settle_hero_capacity_upgrade(p_player_id,p_idempotency_key,p_expected_revision,p_quote_id)
$function$;
DROP FUNCTION public.settle_hero_capacity_upgrade(uuid,uuid,bigint);

REVOKE ALL ON FUNCTION heroloop_api.hero_capacity_quote(uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.hero_capacity_upgrade(uuid,uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_capacity_quote(uuid,bigint) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_capacity_upgrade(uuid,uuid,bigint,uuid) TO heroloop_api;

DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition:=pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated:=replace(v_definition,'(''hero_release'',10,60),','(''hero_release'',10,60),(''hero_capacity_quote'',20,60),');
  IF position('(''hero_capacity_quote'',20,60)' IN v_updated)=0 THEN
    RAISE EXCEPTION 'hero_capacity_quote_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END
$$;
