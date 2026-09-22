CREATE TABLE IF NOT EXISTS public.promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  rewards jsonb NOT NULL CHECK (jsonb_typeof(rewards) = 'object'),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.promo_code_redemptions (
  promo_code_id uuid NOT NULL REFERENCES public.promo_codes(id) ON DELETE RESTRICT,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL UNIQUE,
  result jsonb NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promo_code_id, player_id)
);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_code_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.promo_codes, public.promo_code_redemptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_codes TO service_role;
GRANT SELECT, INSERT ON TABLE public.promo_code_redemptions TO service_role;

CREATE OR REPLACE FUNCTION public.redeem_promo_code(
  p_player_id uuid,
  p_code_hash text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code public.promo_codes%ROWTYPE;
  v_existing public.promo_code_redemptions%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_result jsonb;
  v_gold bigint;
  v_hero numeric;
  v_scrolls bigint;
  v_boss_keys bigint;
  v_balance numeric;
  v_revision bigint;
BEGIN
  IF p_code_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_promo_code'; END IF;

  SELECT * INTO v_code FROM public.promo_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR NOT v_code.active OR v_code.starts_at > now() OR (v_code.ends_at IS NOT NULL AND v_code.ends_at <= now()) THEN
    RAISE EXCEPTION 'invalid_promo_code';
  END IF;

  SELECT * INTO v_existing
  FROM public.promo_code_redemptions
  WHERE promo_code_id = v_code.id AND player_id = p_player_id;
  IF FOUND THEN
    IF v_existing.idempotency_key = p_idempotency_key THEN
      RETURN v_existing.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'promo_code_already_redeemed';
  END IF;

  IF v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions THEN
    RAISE EXCEPTION 'promo_code_exhausted';
  END IF;

  IF v_code.rewards - ARRAY['gold', 'hero', 'summon_scrolls', 'boss_keys'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_promo_rewards';
  END IF;

  BEGIN
    v_gold := COALESCE((v_code.rewards->>'gold')::bigint, 0);
    v_hero := COALESCE((v_code.rewards->>'hero')::numeric, 0);
    v_scrolls := COALESCE((v_code.rewards->>'summon_scrolls')::bigint, 0);
    v_boss_keys := COALESCE((v_code.rewards->>'boss_keys')::bigint, 0);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid_promo_rewards';
  END;

  IF v_gold < 0 OR v_gold > 1000000000 OR v_hero < 0 OR v_hero > 1000000000
    OR v_scrolls < 0 OR v_scrolls > 10000 OR v_boss_keys < 0 OR v_boss_keys > 10000
    OR v_gold + v_hero + v_scrolls + v_boss_keys <= 0
    OR v_hero <> trunc(v_hero) THEN
    RAISE EXCEPTION 'invalid_promo_rewards';
  END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_balance := v_balance + v_hero;
  v_state := v_save.state;
  v_state := jsonb_set(v_state, '{gold}', to_jsonb(GREATEST(0, COALESCE((v_state->>'gold')::bigint, 0)) + v_gold), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
  v_state := jsonb_set(v_state, '{summonScrolls}', to_jsonb(GREATEST(0, COALESCE((v_state->>'summonScrolls')::bigint, 0)) + v_scrolls), true);
  v_state := jsonb_set(v_state, '{bossKeys}', to_jsonb(GREATEST(0, COALESCE((v_state->>'bossKeys')::bigint, 0)) + v_boss_keys), true);

  UPDATE public.players SET token_balance = v_balance, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_code.id;

  v_result := jsonb_build_object(
    'label', v_code.label,
    'rewards', jsonb_build_object('gold', v_gold, 'hero', v_hero, 'summon_scrolls', v_scrolls, 'boss_keys', v_boss_keys),
    'state', v_state,
    'revision', v_revision,
    'token_balance', v_balance,
    'replayed', false
  );
  INSERT INTO public.promo_code_redemptions (promo_code_id, player_id, idempotency_key, result)
  VALUES (v_code.id, p_player_id, p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_promo_code(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_promo_code(uuid, text, uuid) TO service_role;
