\set ON_ERROR_STOP on

DROP FUNCTION heroloop_api.hero_summon_quote(uuid,bigint,integer);
CREATE FUNCTION heroloop_api.hero_summon_quote(
  p_player_id uuid,p_expected_revision bigint,p_count integer,p_test_token_mode boolean
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
  SELECT CASE WHEN p_test_token_mode
    THEN public.quote_test_hero_summon(p_player_id,p_expected_revision,p_count)
    ELSE public.quote_hero_summon(p_player_id,p_expected_revision,p_count)
  END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.hero_summon_quote(uuid,bigint,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_summon_quote(uuid,bigint,integer,boolean) TO heroloop_api;
