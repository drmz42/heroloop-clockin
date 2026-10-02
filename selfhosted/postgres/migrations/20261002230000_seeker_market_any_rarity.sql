-- Founder 2026-10-02: the Seeker Market lists equipment of any rarity, because every
-- listing pays the non-refundable $0.02 SKR fee. Ownership, lock, equipped, state and the
-- 20 active listings per seller checks stay. The ordinary-game settle_market_list is unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION public.seeker_settle_market_list(p_player_id uuid, p_idempotency_key uuid, p_item_id uuid, p_price bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'list' OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('market-seller-limit:' || p_player_id::text, 0));
  IF (SELECT count(*) FROM public.market_item_listings WHERE status = 'active' AND seller_id = p_player_id) >= 20 THEN
    RAISE EXCEPTION 'market_seller_limit_reached';
  END IF;
  SELECT * INTO v_item FROM public.player_items WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF v_item.locked THEN RAISE EXCEPTION 'item_locked'; END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) entry WHERE entry->>'uid' = p_item_id::text) THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero,
    LATERAL jsonb_each_text(COALESCE(hero->'equipped', '{}'::jsonb)) equipped WHERE equipped.value = p_item_id::text) THEN RAISE EXCEPTION 'item_equipped'; END IF;
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_inventory FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) entry WHERE entry->>'uid' <> p_item_id::text;
  v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now() WHERE player_id = p_player_id RETURNING revision INTO v_revision;

  INSERT INTO public.market_item_listings(item_id, seller_id, price) VALUES (p_item_id, p_player_id, p_price) RETURNING * INTO v_listing;
  v_result := jsonb_build_object('listing', public.market_listing_json(v_listing), 'inventory', v_inventory, 'revision', v_revision);
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result) VALUES (p_idempotency_key, p_player_id, 'list', v_request, v_result);
  RETURN v_result;
END;
$$;
COMMIT;
