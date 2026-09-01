CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_progression(p_player_id uuid, p_kind text)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.credit_tester_progression(p_player_id, p_kind, 2000);
$$;

REVOKE ALL ON FUNCTION heroloop_api.tester_credit_progression(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.tester_credit_progression(uuid, text) TO heroloop_api;

-- All Tester grants share one abuse-control bucket. Full Staging QA exercises
-- all four controls plus setup funding, so keep the bounded allowance at ten.
DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''tester_credit_tokens'',5,60)', '(''tester_credit_tokens'',10,60)');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'tester_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END;
$$;
