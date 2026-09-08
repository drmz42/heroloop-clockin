\set ON_ERROR_STOP on

DROP FUNCTION heroloop_api.hero_summon(uuid,uuid,integer);
CREATE FUNCTION heroloop_api.hero_summon_quote(
  p_player_id uuid,p_expected_revision bigint,p_count integer
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
  SELECT public.quote_hero_summon(p_player_id,p_expected_revision,p_count)
$function$;
CREATE FUNCTION heroloop_api.hero_summon(
  p_player_id uuid,p_idempotency_key uuid,p_count integer,p_expected_revision bigint,
  p_payment_method text,p_quote_id uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
  SELECT public.settle_hero_summon(
    p_player_id,p_idempotency_key,p_count,p_expected_revision,p_payment_method,p_quote_id
  )
$function$;

REVOKE ALL ON FUNCTION heroloop_api.hero_summon_quote(uuid,bigint,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.hero_summon(uuid,uuid,integer,bigint,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_summon_quote(uuid,bigint,integer) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_summon(uuid,uuid,integer,bigint,text,uuid) TO heroloop_api;

DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition:=pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated:=replace(v_definition,'(''hero_capacity_quote'',20,60),','(''hero_capacity_quote'',20,60),(''hero_summon_quote'',20,60),');
  IF position('(''hero_summon_quote'',20,60)' IN v_updated)=0 THEN
    RAISE EXCEPTION 'hero_summon_quote_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END
$$;
