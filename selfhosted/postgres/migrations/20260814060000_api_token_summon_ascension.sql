\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.claim_tokens(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'claimed', claim_result.claimed,
    'pending', claim_result.pending,
    'total_claimed', claim_result.total_claimed,
    'token_balance', claim_result.token_balance
  )
  FROM public.claim_player_tokens(p_player_id) claim_result
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_tokens(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_credited boolean;
  v_result jsonb;
BEGIN
  v_credited := public.credit_token_distribution(p_player_id, 10000);
  IF v_credited IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'tester_credit_failed';
  END IF;
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

CREATE OR REPLACE FUNCTION heroloop_api.spend_tokens(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_action_kind text
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'spent', spend_result.spent,
    'token_balance', spend_result.token_balance,
    'boost_tokens_spent', spend_result.boost_tokens_spent
  )
  FROM public.settle_token_spend(p_player_id, p_idempotency_key, p_amount, p_action_kind) spend_result
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.promo_redeem(
  p_player_id uuid,
  p_code_hash text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.redeem_promo_code(p_player_id, p_code_hash, p_idempotency_key)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.ascension_focus_set(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_rarity text,
  p_target_hero_id text
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.set_ascension_focus(p_player_id, p_idempotency_key, p_rarity, p_target_hero_id)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.hero_summon(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_count integer
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_hero_summon(p_player_id, p_idempotency_key, p_count)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.hero_ascend(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_uid text,
  p_repeat boolean
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_hero_ascension(p_player_id, p_idempotency_key, p_target_uid, p_repeat)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.hero_promote_all(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_uids jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_target_uids text[];
BEGIN
  IF jsonb_typeof(p_target_uids) <> 'array' THEN RAISE EXCEPTION 'invalid_targets'; END IF;
  SELECT array_agg(value ORDER BY ordinality) INTO v_target_uids
  FROM jsonb_array_elements_text(p_target_uids) WITH ORDINALITY AS target(value, ordinality);
  RETURN public.settle_all_hero_ascensions(p_player_id, p_idempotency_key, v_target_uids);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.claim_tokens(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.tester_credit_tokens(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.spend_tokens(uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.promo_redeem(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.ascension_focus_set(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.hero_summon(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.hero_ascend(uuid, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.hero_promote_all(uuid, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION heroloop_api.claim_tokens(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.tester_credit_tokens(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.spend_tokens(uuid, uuid, numeric, text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.promo_redeem(uuid, text, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.ascension_focus_set(uuid, uuid, text, text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_summon(uuid, uuid, integer) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_ascend(uuid, uuid, text, boolean) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.hero_promote_all(uuid, uuid, jsonb) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.tester_credit_tokens(uuid) IS
  'Staging-only transport fixture; the API environment gate must reject it elsewhere.';
COMMENT ON FUNCTION heroloop_api.hero_promote_all(uuid, uuid, jsonb) IS
  'Bounded JSON transport wrapper around the canonical atomic Promote All settlement.';
