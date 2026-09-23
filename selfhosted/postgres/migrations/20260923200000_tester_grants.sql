\set ON_ERROR_STOP on

-- Staging Tester amounts are fixed on the server. The transport still rejects
-- every Tester action unless TESTER_CONTROLS_ENABLED=true.
DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef('public.credit_tester_gold(uuid,bigint)'::regprocedure);
  v_updated := replace(v_definition, 'p_amount <> 10000', 'p_amount <> 50000');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'tester_gold_amount_patch_failed'; END IF;
  EXECUTE v_updated;

  v_definition := pg_get_functiondef('public.credit_tester_progression(uuid,text,bigint)'::regprocedure);
  v_updated := replace(v_definition, 'p_amount <> 2000', 'p_amount <> 40000');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'tester_progression_amount_patch_failed'; END IF;
  EXECUTE v_updated;

  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''tester_credit_tokens'',10,60)', '(''tester_credit_tokens'',120,60)');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'tester_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_gold(p_player_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT public.credit_tester_gold(p_player_id, 50000)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_progression(p_player_id uuid, p_kind text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT public.credit_tester_progression(p_player_id, p_kind, 40000)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_tokens(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_credited boolean;
  v_result jsonb;
BEGIN
  v_credited := public.credit_token_distribution(p_player_id, 50000);
  IF v_credited IS DISTINCT FROM true THEN RAISE EXCEPTION 'tester_credit_failed'; END IF;
  SELECT jsonb_build_object(
    'claimed', claim_result.claimed,
    'pending', claim_result.pending,
    'total_claimed', claim_result.total_claimed,
    'token_balance', claim_result.token_balance
  ) INTO v_result
  FROM public.claim_player_tokens(p_player_id) claim_result;
  IF v_result IS NULL THEN RAISE EXCEPTION 'tester_claim_failed'; END IF;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.tester_credit_gold(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.tester_credit_progression(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.tester_credit_tokens(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.tester_credit_gold(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.tester_credit_progression(uuid,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.tester_credit_tokens(uuid) TO heroloop_api;
