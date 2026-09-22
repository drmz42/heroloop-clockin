-- Expand the server Market from Legendary weapons to all wearable Legendary+ equipment.
CREATE OR REPLACE FUNCTION public.settle_market_list(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_item_id uuid,
  p_price bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('item_id', p_item_id, 'price', p_price);
  v_item public.player_items%ROWTYPE;
  v_state jsonb;
  v_listing public.market_item_listings%ROWTYPE;
  v_inventory jsonb;
  v_revision bigint;
  v_balance numeric;
  v_result jsonb;
BEGIN
  IF p_price < 1 OR p_price > 1000000000 THEN RAISE EXCEPTION 'invalid_market_price'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'list' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('market-active-limit', 0));
  IF (SELECT count(*) FROM public.market_item_listings WHERE status = 'active') >= 2 THEN
    RAISE EXCEPTION 'market_test_limit_reached';
  END IF;

  SELECT * INTO v_item FROM public.player_items
    WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF v_item.locked THEN RAISE EXCEPTION 'item_locked'; END IF;
  IF v_item.rarity NOT IN ('legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god')
    OR v_item.slot NOT IN ('weapon', 'class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet', 'armor', 'ring1', 'ring2') THEN
    RAISE EXCEPTION 'market_test_item_required';
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) entry WHERE entry->>'uid' = p_item_id::text) THEN
    RAISE EXCEPTION 'item_state_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero,
      LATERAL jsonb_each_text(COALESCE(hero->'equipped', '{}'::jsonb)) equipped
    WHERE equipped.value = p_item_id::text
  ) THEN RAISE EXCEPTION 'item_equipped'; END IF;

  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_inventory
  FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) entry
  WHERE entry->>'uid' <> p_item_id::text;
  v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;

  INSERT INTO public.market_item_listings(item_id, seller_id, price)
    VALUES (p_item_id, p_player_id, p_price) RETURNING * INTO v_listing;
  v_result := jsonb_build_object(
    'listing', public.market_listing_json(v_listing),
    'inventory', v_inventory,
    'token_balance', v_balance,
    'revision', v_revision
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'list', v_request, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_market_list(uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_market_list(uuid, uuid, uuid, bigint) TO service_role;
