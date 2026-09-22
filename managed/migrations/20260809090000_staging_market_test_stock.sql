ALTER TABLE public.market_item_events DROP CONSTRAINT IF EXISTS market_item_events_action_check;
ALTER TABLE public.market_item_events ADD CONSTRAINT market_item_events_action_check
  CHECK (action IN ('list', 'cancel', 'buy', 'seed'));

CREATE OR REPLACE FUNCTION public.seed_market_test_stock(
  p_player_id uuid,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := '{}'::jsonb;
  v_username text;
  v_item_id uuid;
  v_listing public.market_item_listings%ROWTYPE;
  v_listings jsonb := '[]'::jsonb;
  v_index integer;
  v_base_item_id text;
  v_slot text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'seed' THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  SELECT username INTO v_username FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF v_username IS DISTINCT FROM 'MarketStock' THEN RAISE EXCEPTION 'market_test_seed_forbidden'; END IF;
  PERFORM 1 FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('market-active-limit', 0));
  IF EXISTS (SELECT 1 FROM public.market_item_listings WHERE status = 'active') THEN
    RAISE EXCEPTION 'market_test_stock_not_empty';
  END IF;

  FOR v_index IN 1..2 LOOP
    v_base_item_id := CASE v_index WHEN 1 THEN 'weapon-warrior-legendary' ELSE 'weapon-crossbowman-legendary' END;
    v_slot := 'class_weapon';
    INSERT INTO public.player_items(
      player_id, base_item_id, slot, rarity, item_level, stats, power, locked,
      enchant_level, reroll_count, enchant_stats_version, source_kind
    ) VALUES (
      p_player_id, v_base_item_id, v_slot, 'legendary', 20,
      jsonb_build_array(
        jsonb_build_object('key', 'atk', 'value', CASE v_index WHEN 1 THEN 120 ELSE 110 END, 'isPercent', false),
        jsonb_build_object('key', 'critChance', 'value', CASE v_index WHEN 1 THEN 6 ELSE 8 END, 'isPercent', true),
        jsonb_build_object('key', 'critDamage', 'value', 20, 'isPercent', true)
      ),
      CASE v_index WHEN 1 THEN 520 ELSE 500 END, false, 0, 0, 2, 'market_test_stock'
    ) RETURNING id INTO v_item_id;
    INSERT INTO public.market_item_listings(item_id, seller_id, price)
      VALUES (v_item_id, p_player_id, CASE v_index WHEN 1 THEN 1000 ELSE 2000 END)
      RETURNING * INTO v_listing;
    v_listings := v_listings || jsonb_build_array(public.market_listing_json(v_listing));
  END LOOP;

  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'seed', v_request, jsonb_build_object('listings', v_listings));
  RETURN jsonb_build_object('listings', v_listings);
END;
$$;

REVOKE ALL ON FUNCTION public.seed_market_test_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_market_test_stock(uuid, uuid) TO service_role;
