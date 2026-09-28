-- Shop resource bundles paid with $HERO at a server quote
-- (HL-TASK-20260927234716-87F1EA, docs/game/decisions.md 2026-09-28).
--
-- The catalogue price is USD cents; the server converts it with the same fresh
-- DEX quote as the Gold/XP boost (reward_boost_token_price: last five minutes,
-- or 1,000 $HERO = $1 on pre-token Staging). The client sends the highest
-- $HERO amount it agreed to pay, so a quote move never charges more than the
-- player saw. One transaction debits token_balance (token_spend_events row,
-- copied into hero_economy_ledger as `shop-bundle` by the existing trigger),
-- credits the resources through apply_resource_entries (`shop_bundle` source)
-- and advances the save revision. Replays return the stored result; a reused
-- key with another bundle fails. Sales are final: there is no refund path.

CREATE TABLE IF NOT EXISTS public.shop_bundle_purchase_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  bundle text NOT NULL CHECK (bundle IN ('scroll_1', 'scroll_5', 'boss_key_1', 'boss_key_3', 'potion_md_10')),
  catalogue_usd_cents integer NOT NULL CHECK (catalogue_usd_cents BETWEEN 1 AND 100000),
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  quote_source text NOT NULL CHECK (quote_source ~ '^[a-z0-9_-]{1,64}$'),
  dex_quote_id uuid REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  resource_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS shop_bundle_purchase_events_player_idx
  ON public.shop_bundle_purchase_events(player_id, created_at DESC);
ALTER TABLE public.shop_bundle_purchase_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.shop_bundle_purchase_events FROM PUBLIC;

-- Founder-approved starter catalogue (2026-09-28). Order is the display order.
CREATE OR REPLACE FUNCTION public.shop_bundle_catalog()
RETURNS TABLE(bundle text, resource_id text, quantity integer, catalogue_usd_cents integer)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT * FROM (VALUES
    ('scroll_1', 'summon_scroll', 1, 100),
    ('scroll_5', 'summon_scroll', 5, 450),
    ('boss_key_1', 'boss_key', 1, 100),
    ('boss_key_3', 'boss_key', 3, 250),
    ('potion_md_10', 'potion_md', 10, 100)
  ) AS v(bundle, resource_id, quantity, catalogue_usd_cents)
$$;
REVOKE ALL ON FUNCTION public.shop_bundle_catalog() FROM PUBLIC;

-- Bundle resources enter the resource ledger under their own source key.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)'::regprocedure);
  v_new := replace(v_def, $f$'partner_quest_reward']$f$, $f$'partner_quest_reward','shop_bundle']$f$);
  IF v_new = v_def THEN RAISE EXCEPTION 'shop_bundle_resource_patch_failed'; END IF;
  EXECUTE v_new;
  v_def := pg_get_functiondef('public.resource_ledger_reconciliation()'::regprocedure);
  v_new := replace(v_def, $f$'partner_quest_reward']$f$, $f$'partner_quest_reward','shop_bundle']$f$);
  IF v_new = v_def THEN RAISE EXCEPTION 'shop_bundle_reconciliation_patch_failed'; END IF;
  EXECUTE v_new;
END
$$;

-- The Shop snapshot: the boost snapshot plus bundle prices at the current quote.
CREATE OR REPLACE FUNCTION public.account_bonus_snapshot(p_player_id uuid, p_pretoken boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_plans jsonb := '[]'::jsonb;
  v_bundles jsonb := '[]'::jsonb;
  v_plan text;
  v_price jsonb;
  v_cents integer;
  v_days integer;
  v_bundle record;
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
  FOR v_bundle IN SELECT * FROM public.shop_bundle_catalog() LOOP
    BEGIN
      v_price := public.reward_boost_token_price(v_bundle.catalogue_usd_cents, p_pretoken);
    EXCEPTION WHEN raise_exception THEN
      v_price := NULL;
    END;
    v_bundles := v_bundles || jsonb_build_object('bundle', v_bundle.bundle, 'resource_id', v_bundle.resource_id,
      'quantity', v_bundle.quantity, 'catalogue_usd_cents', v_bundle.catalogue_usd_cents,
      'token_cost', v_price->'token_cost', 'available', v_price IS NOT NULL);
  END LOOP;
  RETURN jsonb_build_object(
    'bonus', public.account_reward_bonus(p_player_id),
    'boost', jsonb_build_object('gold', 1.00, 'xp', 1.00, 'expires_at', (
      SELECT expires_at FROM public.player_account_bonuses
      WHERE player_id = p_player_id AND source_key = 'reward_boost'
        AND revoked_at IS NULL AND expires_at > now())),
    'plans', v_plans,
    'bundles', v_bundles,
    'server_time', clock_timestamp()
  );
END;
$$;
REVOKE ALL ON FUNCTION public.account_bonus_snapshot(uuid, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.settle_shop_bundle_purchase(
  p_player_id uuid, p_idempotency_key uuid, p_bundle text, p_max_token_cost numeric,
  p_expected_revision bigint, p_pretoken boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_existing public.shop_bundle_purchase_events%ROWTYPE;
  v_item record;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_price jsonb;
  v_cost numeric;
  v_balance numeric;
  v_resource jsonb;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_max_token_cost IS NULL OR p_max_token_cost <= 0 OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'invalid_shop_bundle_purchase';
  END IF;
  SELECT * INTO v_item FROM public.shop_bundle_catalog() c WHERE c.bundle = p_bundle;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_shop_bundle_purchase'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.shop_bundle_purchase_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.bundle <> p_bundle THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;

  v_price := public.reward_boost_token_price(v_item.catalogue_usd_cents, p_pretoken);
  v_cost := (v_price->>'token_cost')::numeric;
  IF v_cost > p_max_token_cost THEN RAISE EXCEPTION 'price_changed'; END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_balance < v_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  UPDATE public.players SET token_balance = token_balance - v_cost, updated_at = now()
  WHERE player_id = p_player_id RETURNING token_balance INTO v_balance;
  INSERT INTO public.token_spend_events(idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, v_cost, 'shop-bundle');

  v_resource := public.apply_resource_entries(p_player_id, p_idempotency_key, 'shop_bundle_buy',
    encode(extensions.digest(('shop-bundle:' || p_idempotency_key::text || ':' || p_bundle)::bytea, 'sha256'), 'hex'),
    jsonb_build_array(jsonb_build_object('resource_id', v_item.resource_id, 'delta', v_item.quantity::text,
      'source_key', 'shop_bundle')),
    v_save.revision + 1);
  v_state := v_save.state;
  v_state := jsonb_set(v_state, '{summonScrolls}', to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint), true);
  v_state := jsonb_set(v_state, '{bossKeys}', to_jsonb((v_resource#>>'{balances,boss_key}')::bigint), true);
  v_state := jsonb_set(v_state, '{potions}', COALESCE(v_state->'potions', '{}'::jsonb) || jsonb_build_object(
    'xs', (v_resource#>>'{balances,potion_xs}')::bigint, 'sm', (v_resource#>>'{balances,potion_sm}')::bigint,
    'md', (v_resource#>>'{balances,potion_md}')::bigint, 'lg', (v_resource#>>'{balances,potion_lg}')::bigint,
    'xl', (v_resource#>>'{balances,potion_xl}')::bigint, 'xxl', (v_resource#>>'{balances,potion_xxl}')::bigint), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
  UPDATE public.players SET boss_keys = (v_resource#>>'{balances,boss_key}')::integer WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;

  v_result := jsonb_build_object(
    'bundle', p_bundle, 'resource_id', v_item.resource_id, 'quantity', v_item.quantity,
    'catalogue_usd_cents', v_item.catalogue_usd_cents, 'spent', v_cost,
    'quote_source', v_price->>'quote_source', 'hero_usd_quote_micros', v_price->'hero_usd_quote_micros',
    'token_balance', v_balance, 'resource_balance', (v_resource#>>ARRAY['balances', v_item.resource_id])::bigint,
    'state', v_state, 'revision', v_revision, 'replayed', false);
  INSERT INTO public.shop_bundle_purchase_events(idempotency_key, player_id, bundle, catalogue_usd_cents,
    token_cost, quote_source, dex_quote_id, resource_id, quantity, result)
  VALUES (p_idempotency_key, p_player_id, p_bundle, v_item.catalogue_usd_cents, v_cost, v_price->>'quote_source',
    (v_price->>'dex_quote_id')::uuid, v_item.resource_id, v_item.quantity, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.settle_shop_bundle_purchase(uuid, uuid, text, numeric, bigint, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_api.shop_bundle_buy(
  p_player_id uuid, p_idempotency_key uuid, p_bundle text, p_max_token_cost numeric,
  p_expected_revision bigint, p_pretoken boolean
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT public.settle_shop_bundle_purchase(p_player_id, p_idempotency_key, p_bundle, p_max_token_cost,
    p_expected_revision, p_pretoken)
$$;
REVOKE ALL ON FUNCTION heroloop_api.shop_bundle_buy(uuid, uuid, text, numeric, bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.shop_bundle_buy(uuid, uuid, text, numeric, bigint, boolean) TO heroloop_api;

DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''reward_boost_buy'',10,60),',
    '(''reward_boost_buy'',10,60),(''shop_bundle_buy'',10,60),');
  IF position('(''shop_bundle_buy'',10,60)' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'shop_bundle_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END
$$;

-- `shop-bundle` is a known treasury inflow for the $HERO reconciliation.
CREATE OR REPLACE FUNCTION admin.hero_ledger_known_kinds()
RETURNS text[] LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT ARRAY[
    'mining_pool', 'promo_code', 'quest-reward', 'tester_credit',
    'hero-summon', 'hero-ascension', 'training-slot',
    'training-boost-2x-1h', 'training-boost-2x-4h', 'training-boost-4x-1h', 'training-boost-4x-4h',
    'item-enchant', 'enchant-charm', 'item-reroll',
    'reward-boost-24h', 'reward-boost-7d', 'reward-boost-30d', 'shop-bundle', 'market_fee',
    'trainingboost2x1h', 'account_balance_extinguishment'
  ]::text[]
$function$;
REVOKE ALL ON FUNCTION admin.hero_ledger_known_kinds() FROM PUBLIC;
