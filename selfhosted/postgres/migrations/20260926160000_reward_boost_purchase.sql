-- Paid Gold/XP boost: +100% Gold and +100% XP for 24 hours ($1), 7 days ($6)
-- or 30 days ($22.50), paid in $HERO at the server quote.
--
-- The price is a USD catalogue value. The server converts it with a fresh DEX
-- quote (observed in the last five minutes); on pre-token Staging, where no
-- market exists, tester controls price it at 1,000 $HERO = $1. The client
-- sends the highest $HERO amount it agreed to pay, so a quote move never
-- charges more than the player saw.
--
-- A purchase extends the one `reward_boost` grant (category timed_boost,
-- capped at +100%/+100%), so buying again adds time, never strength. The
-- spend is a token_spend_events row, which the existing trigger copies into
-- hero_economy_ledger as `reward-boost-<plan>`. Replays return the stored
-- result; a reused key with another plan fails.

INSERT INTO public.account_bonus_sources(source_key, category, gold_bonus, xp_bonus)
VALUES ('reward_boost', 'timed_boost', 1.00, 1.00)
ON CONFLICT (source_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.reward_boost_purchase_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('24h', '7d', '30d')),
  catalogue_usd_cents integer NOT NULL CHECK (catalogue_usd_cents IN (100, 600, 2250)),
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  quote_source text NOT NULL CHECK (quote_source ~ '^[a-z0-9_-]{1,64}$'),
  dex_quote_id uuid REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  boost_expires_at timestamptz NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS reward_boost_purchase_events_player_idx
  ON public.reward_boost_purchase_events(player_id, created_at DESC);
ALTER TABLE public.reward_boost_purchase_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.reward_boost_purchase_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.reward_boost_plan(p_plan text)
RETURNS TABLE(catalogue_usd_cents integer, duration interval, days integer)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT v.cents, v.duration, v.days FROM (VALUES
    ('24h', 100, interval '24 hours', 1),
    ('7d', 600, interval '7 days', 7),
    ('30d', 2250, interval '30 days', 30)
  ) AS v(plan, cents, duration, days)
  WHERE v.plan = p_plan
$$;
REVOKE ALL ON FUNCTION public.reward_boost_plan(text) FROM PUBLIC;

-- {token_cost, quote_source, dex_quote_id, hero_usd_quote_micros} for a USD amount.
CREATE OR REPLACE FUNCTION public.reward_boost_token_price(p_usd_cents integer, p_pretoken boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_dex public.hero_usd_dex_quotes%ROWTYPE;
BEGIN
  SELECT * INTO v_dex FROM public.hero_usd_dex_quotes
  WHERE source <> 'pretoken_test'
    AND observed_at <= clock_timestamp()
    AND observed_at >= clock_timestamp() - interval '5 minutes'
    AND expires_at > clock_timestamp()
  ORDER BY observed_at DESC, created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'token_cost', CEIL((p_usd_cents * 10000)::numeric / v_dex.usd_micros_per_hero),
      'quote_source', v_dex.source, 'dex_quote_id', v_dex.quote_id,
      'hero_usd_quote_micros', v_dex.usd_micros_per_hero);
  END IF;
  IF p_pretoken THEN
    RETURN jsonb_build_object('token_cost', p_usd_cents * 10, 'quote_source', 'pretoken_test',
      'dex_quote_id', NULL, 'hero_usd_quote_micros', 1000);
  END IF;
  RAISE EXCEPTION 'dex_quote_unavailable';
END;
$$;
REVOKE ALL ON FUNCTION public.reward_boost_token_price(integer, boolean) FROM PUBLIC;

-- What the Commander tile and the Shop show: account bonus, boost timer and plan prices.
CREATE OR REPLACE FUNCTION public.account_bonus_snapshot(p_player_id uuid, p_pretoken boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_plans jsonb := '[]'::jsonb;
  v_plan text;
  v_price jsonb;
  v_cents integer;
  v_days integer;
BEGIN
  FOREACH v_plan IN ARRAY ARRAY['24h', '7d', '30d'] LOOP
    SELECT p.catalogue_usd_cents, p.days INTO v_cents, v_days
    FROM public.reward_boost_plan(v_plan) p;
    BEGIN
      v_price := public.reward_boost_token_price(v_cents, p_pretoken);
    EXCEPTION WHEN raise_exception THEN
      v_price := NULL;
    END;
    v_plans := v_plans || jsonb_build_object('plan', v_plan, 'catalogue_usd_cents', v_cents, 'days', v_days,
      'token_cost', v_price->'token_cost', 'available', v_price IS NOT NULL);
  END LOOP;
  RETURN jsonb_build_object(
    'bonus', public.account_reward_bonus(p_player_id),
    'boost', jsonb_build_object('gold', 1.00, 'xp', 1.00, 'expires_at', (
      SELECT expires_at FROM public.player_account_bonuses
      WHERE player_id = p_player_id AND source_key = 'reward_boost'
        AND revoked_at IS NULL AND expires_at > now())),
    'plans', v_plans,
    'server_time', clock_timestamp()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.account_bonus_snapshot(uuid, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.settle_reward_boost_purchase(
  p_player_id uuid, p_idempotency_key uuid, p_plan text, p_max_token_cost numeric, p_pretoken boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_existing public.reward_boost_purchase_events%ROWTYPE;
  v_cents integer;
  v_duration interval;
  v_price jsonb;
  v_cost numeric;
  v_balance numeric;
  v_spent numeric;
  v_now timestamptz := now();
  v_expires timestamptz;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_max_token_cost IS NULL OR p_max_token_cost <= 0 THEN
    RAISE EXCEPTION 'invalid_reward_boost_purchase';
  END IF;
  SELECT p.catalogue_usd_cents, p.duration INTO v_cents, v_duration FROM public.reward_boost_plan(p_plan) p;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_reward_boost_purchase'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.reward_boost_purchase_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.plan <> p_plan THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;

  v_price := public.reward_boost_token_price(v_cents, p_pretoken);
  v_cost := (v_price->>'token_cost')::numeric;
  IF v_cost > p_max_token_cost THEN RAISE EXCEPTION 'price_changed'; END IF;

  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_balance < v_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
  UPDATE public.players
  SET token_balance = token_balance - v_cost,
      boost_tokens_spent = boost_tokens_spent + v_cost,
      updated_at = v_now
  WHERE player_id = p_player_id
  RETURNING token_balance, boost_tokens_spent INTO v_balance, v_spent;
  INSERT INTO public.token_spend_events(idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, v_cost,
    CASE p_plan WHEN '24h' THEN 'reward-boost-24h' WHEN '7d' THEN 'reward-boost-7d' ELSE 'reward-boost-30d' END);

  INSERT INTO public.player_account_bonuses(player_id, source_key, granted_at, expires_at, grant_reason)
  VALUES (p_player_id, 'reward_boost', v_now, v_now + v_duration, 'purchase:reward-boost')
  ON CONFLICT (player_id, source_key) DO UPDATE SET
    granted_at = CASE WHEN player_account_bonuses.revoked_at IS NULL AND player_account_bonuses.expires_at > v_now
      THEN player_account_bonuses.granted_at ELSE v_now END,
    expires_at = CASE WHEN player_account_bonuses.revoked_at IS NULL AND player_account_bonuses.expires_at > v_now
      THEN player_account_bonuses.expires_at ELSE v_now END + v_duration,
    revoked_at = NULL,
    grant_reason = 'purchase:reward-boost'
  RETURNING expires_at INTO v_expires;

  v_result := jsonb_build_object(
    'plan', p_plan, 'catalogue_usd_cents', v_cents, 'spent', v_cost,
    'quote_source', v_price->>'quote_source', 'hero_usd_quote_micros', v_price->'hero_usd_quote_micros',
    'token_balance', v_balance, 'boost_tokens_spent', v_spent,
    'boost_expires_at', v_expires, 'bonus', public.account_reward_bonus(p_player_id));
  INSERT INTO public.reward_boost_purchase_events(idempotency_key, player_id, plan, catalogue_usd_cents,
    token_cost, quote_source, dex_quote_id, boost_expires_at, result)
  VALUES (p_idempotency_key, p_player_id, p_plan, v_cents, v_cost, v_price->>'quote_source',
    (v_price->>'dex_quote_id')::uuid, v_expires, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.settle_reward_boost_purchase(uuid, uuid, text, numeric, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_api.account_bonus_snapshot(p_player_id uuid, p_pretoken boolean)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.account_bonus_snapshot(p_player_id, p_pretoken)
$$;
CREATE OR REPLACE FUNCTION heroloop_api.reward_boost_buy(
  p_player_id uuid, p_idempotency_key uuid, p_plan text, p_max_token_cost numeric, p_pretoken boolean
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.settle_reward_boost_purchase(p_player_id, p_idempotency_key, p_plan, p_max_token_cost, p_pretoken)
$$;
REVOKE ALL ON FUNCTION heroloop_api.account_bonus_snapshot(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.reward_boost_buy(uuid, uuid, text, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.account_bonus_snapshot(uuid, boolean) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.reward_boost_buy(uuid, uuid, text, numeric, boolean) TO heroloop_api;

DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''hero_release'',10,60),',
    '(''hero_release'',10,60),(''account_bonus_snapshot'',30,60),(''reward_boost_buy'',10,60),');
  IF position('(''reward_boost_buy'',10,60)' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'reward_boost_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END
$$;
