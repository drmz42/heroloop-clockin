\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.training_assignment_set(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_slot_index integer,
  p_hero_uid text,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_training_assignment(p_player_id,p_idempotency_key,p_slot_index,p_hero_uid,p_expected_revision)
$function$;

REVOKE ALL ON FUNCTION heroloop_api.training_assignment_set(uuid,uuid,integer,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.training_assignment_set(uuid,uuid,integer,text,bigint) TO heroloop_api;

DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := v_definition;
  IF position('(''training_assignment_set'',' IN v_updated) = 0 THEN
    v_updated := replace(v_updated, '(''hero_release'',10,60),', '(''hero_release'',10,60),(''training_assignment_set'',20,60),');
  END IF;
  IF position('(''training_assignment_set'',20,60)' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'training_assignment_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END;
$$;

COMMENT ON FUNCTION heroloop_api.training_assignment_set(uuid,uuid,integer,text,bigint) IS
  'Bounded API wrapper for server-owned Training Camp assignment settlement.';
