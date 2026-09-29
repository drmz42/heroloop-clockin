-- Sequential equipment bags. Existing saves keep their 64 accessible Bag-1 cells;
-- new registrations use 48. Prices are USD catalogue cents converted by the
-- same fresh server quote as Shop bundles. No price or balance is trusted from a client.

CREATE OR REPLACE FUNCTION public.inventory_bag_capacity(p_state jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((SELECT sum(value::integer) FROM jsonb_array_elements_text(p_state->'bagSlots')), 64)::integer
$$;
REVOKE ALL ON FUNCTION public.inventory_bag_capacity(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.inventory_bag_next_step(p_state jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE v_slots jsonb := p_state->'bagSlots'; v_bag integer;
BEGIN
  IF jsonb_typeof(v_slots) <> 'array' OR jsonb_array_length(v_slots) <> 4 THEN
    v_slots := '[64,0,0,0]'::jsonb;
  END IF;
  FOR v_bag IN 1..4 LOOP
    IF (v_slots->>(v_bag - 1))::integer = 48 THEN
      RETURN jsonb_build_object('bag', v_bag, 'slots', 64, 'kind', 'upgrade', 'catalogue_usd_cents', v_bag * 100);
    END IF;
    IF v_bag < 4 AND (v_slots->>v_bag)::integer = 0 THEN
      RETURN jsonb_build_object('bag', v_bag + 1, 'slots', 48, 'kind', 'buy', 'catalogue_usd_cents', (v_bag + 2) * 100);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.inventory_bag_next_step(jsonb) FROM PUBLIC;

CREATE TABLE public.inventory_bag_purchase_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  bag integer NOT NULL CHECK (bag BETWEEN 1 AND 4),
  kind text NOT NULL CHECK (kind IN ('buy', 'upgrade')),
  max_token_cost numeric NOT NULL CHECK (max_token_cost > 0),
  expected_revision bigint NOT NULL,
  catalogue_usd_cents integer NOT NULL,
  token_cost numeric NOT NULL CHECK (token_cost > 0),
  quote_source text NOT NULL,
  dex_quote_id uuid REFERENCES public.hero_usd_dex_quotes(quote_id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX inventory_bag_purchase_events_player_idx ON public.inventory_bag_purchase_events(player_id, created_at DESC);
ALTER TABLE public.inventory_bag_purchase_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_bag_purchase_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_api.inventory_bag_quote(p_player_id uuid, p_pretoken boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_state jsonb; v_step jsonb; v_price jsonb;
BEGIN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_step := public.inventory_bag_next_step(v_state);
  IF v_step IS NULL THEN RETURN jsonb_build_object('complete', true); END IF;
  BEGIN
    v_price := public.reward_boost_token_price((v_step->>'catalogue_usd_cents')::integer, p_pretoken);
  EXCEPTION WHEN raise_exception THEN
    RETURN v_step || jsonb_build_object('available', false);
  END;
  RETURN v_step || jsonb_build_object('available', true, 'token_cost', v_price->'token_cost',
    'quote_source', v_price->'quote_source');
END;
$$;
REVOKE ALL ON FUNCTION heroloop_api.inventory_bag_quote(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.inventory_bag_quote(uuid,boolean) TO heroloop_api;

CREATE OR REPLACE FUNCTION heroloop_api.inventory_bag_buy(
  p_player_id uuid, p_key uuid, p_bag integer, p_kind text, p_max_token_cost numeric,
  p_expected_revision bigint, p_pretoken boolean
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_existing public.inventory_bag_purchase_events%ROWTYPE; v_save public.player_saves%ROWTYPE;
  v_step jsonb; v_price jsonb; v_cost numeric; v_balance numeric; v_slots jsonb; v_state jsonb;
  v_revision bigint; v_result jsonb;
BEGIN
  IF p_key IS NULL OR p_bag NOT BETWEEN 1 AND 4 OR p_kind NOT IN ('buy','upgrade')
    OR p_max_token_cost IS NULL OR p_max_token_cost <= 0 OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'invalid_inventory_bag_purchase';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text, 0));
  SELECT * INTO v_existing FROM public.inventory_bag_purchase_events WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.bag <> p_bag OR v_existing.kind <> p_kind
      OR v_existing.max_token_cost <> p_max_token_cost OR v_existing.expected_revision <> p_expected_revision
      THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.token_spend_events WHERE idempotency_key = p_key)
    THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_step := public.inventory_bag_next_step(v_save.state);
  IF v_step IS NULL OR (v_step->>'bag')::integer <> p_bag OR v_step->>'kind' <> p_kind
    THEN RAISE EXCEPTION 'bag_step_unavailable'; END IF;
  v_price := public.reward_boost_token_price((v_step->>'catalogue_usd_cents')::integer, p_pretoken);
  v_cost := (v_price->>'token_cost')::numeric;
  IF v_cost > p_max_token_cost THEN RAISE EXCEPTION 'price_changed'; END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_balance < v_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
  UPDATE public.players SET token_balance = token_balance - v_cost, updated_at = now()
    WHERE player_id = p_player_id RETURNING token_balance INTO v_balance;
  INSERT INTO public.token_spend_events(idempotency_key, player_id, amount, action_kind)
    VALUES (p_key, p_player_id, v_cost, 'inventory-bag');
  v_slots := COALESCE(v_save.state->'bagSlots', '[64,0,0,0]'::jsonb);
  v_slots := jsonb_set(v_slots, ARRAY[(p_bag - 1)::text], v_step->'slots');
  v_state := jsonb_set(jsonb_set(v_save.state, '{bagSlots}', v_slots, true), '{hero}', to_jsonb(v_balance), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  v_result := v_step || jsonb_build_object('spent', v_cost, 'token_balance', v_balance,
    'bag_slots', v_slots, 'revision', v_revision, 'replayed', false);
  INSERT INTO public.inventory_bag_purchase_events(idempotency_key,player_id,bag,kind,max_token_cost,expected_revision,
    catalogue_usd_cents,token_cost,quote_source,dex_quote_id,result)
    VALUES (p_key,p_player_id,p_bag,p_kind,p_max_token_cost,p_expected_revision,
      (v_step->>'catalogue_usd_cents')::integer,v_cost,v_price->>'quote_source',(v_price->>'dex_quote_id')::uuid,v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION heroloop_api.inventory_bag_buy(uuid,uuid,integer,text,numeric,bigint,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.inventory_bag_buy(uuid,uuid,integer,text,numeric,bigint,boolean) TO heroloop_api;

-- Replace only the capacity expressions in the established item settlements.
-- Preserve their item generation, ledger, equipment and Mailbox behavior.
DO $$
DECLARE v_spec record; v_def text; v_new text;
BEGIN
  FOR v_spec IN SELECT * FROM (VALUES
    ('public.settle_chest_open(uuid,uuid,integer)', 'v_bag_count + p_count > 64', 'v_bag_count + p_count > public.inventory_bag_capacity(v_state)'),
    ('public.settle_item_equipment_before_compact_receipt(uuid,uuid,jsonb)', 'v_bag_count > 64 AND v_bag_count > v_prior_bag_count', 'v_bag_count > public.inventory_bag_capacity(v_state) AND v_bag_count > v_prior_bag_count'),
    ('public.settle_store_purchase(uuid,uuid,integer,bigint)', 'v_bag_count >= 64', 'v_bag_count >= public.inventory_bag_capacity(v_state)'),
    ('heroloop_api.mail_claim(uuid,uuid,uuid)', '64 - public.server_market_bag_count(v_state)', 'public.inventory_bag_capacity(v_state) - public.server_market_bag_count(v_state)'),
    ('public.settle_market_cancel(uuid,uuid,uuid)', 'public.server_market_bag_count(v_state) >= 64', 'public.server_market_bag_count(v_state) >= public.inventory_bag_capacity(v_state)')
  ) AS spec(signature, old_expression, new_expression) LOOP
    v_def := pg_get_functiondef(v_spec.signature::regprocedure);
    v_new := replace(v_def, v_spec.old_expression, v_spec.new_expression);
    IF v_def = v_new THEN RAISE EXCEPTION 'inventory_bag_capacity_patch_failed: %', v_spec.signature; END IF;
    EXECUTE v_new;
  END LOOP;
END;
$$;

-- The treasury audit must classify this token sink explicitly.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('admin.hero_ledger_known_kinds()'::regprocedure);
  v_new := replace(v_def, $find$'shop-bundle', 'market_fee'$find$,
    $new$'shop-bundle', 'inventory-bag', 'market_fee'$new$);
  IF v_def = v_new THEN RAISE EXCEPTION 'inventory_bag_reconciliation_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;
