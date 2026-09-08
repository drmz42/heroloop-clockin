\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.hero_capacity_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_hero_capacity_upgrade(p_player_id, p_idempotency_key, p_expected_revision)
$function$;

REVOKE ALL ON FUNCTION heroloop_api.hero_capacity_upgrade(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_capacity_upgrade(uuid,uuid,bigint) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.hero_capacity_upgrade(uuid,uuid,bigint) IS
  'Bounded API wrapper for permanent server-authoritative Hero-capacity upgrades.';

DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''tester_credit_tokens'',5,60)', '(''tester_credit_tokens'',10,60)');
  IF position('(''hero_capacity_upgrade'',' IN v_updated) = 0 THEN
    v_updated := replace(
      v_updated,
      '(''hero_release'',10,60),',
      '(''hero_release'',10,60),(''hero_capacity_upgrade'',10,60),'
    );
  END IF;
  IF position('(''hero_capacity_upgrade'',10,60)' IN v_updated) = 0
    OR position('(''tester_credit_tokens'',10,60)' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'hero_capacity_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END;
$$;
