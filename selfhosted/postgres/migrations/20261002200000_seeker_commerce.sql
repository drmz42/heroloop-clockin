-- Dedicated SKR commerce adapters. Only the Seeker API dispatches these functions.
-- Existing ordinary-game settlement and currency functions are preserved.
BEGIN;
CREATE TABLE IF NOT EXISTS public.seeker_commerce_requests (
 id uuid PRIMARY KEY, player_id uuid NOT NULL REFERENCES public.players(player_id),
 action text NOT NULL, params jsonb NOT NULL, context jsonb NOT NULL, usd_cents numeric(12,4) NOT NULL CHECK(usd_cents>0),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','delivered','rejected')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.seeker_commerce_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seeker_commerce_requests FROM PUBLIC,anon,authenticated;


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
  IF v_item.rarity NOT IN ('legendary', 'mythic', 'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god')
    OR v_item.slot NOT IN ('weapon', 'class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet', 'armor', 'ring1', 'ring2') THEN
    RAISE EXCEPTION 'market_test_item_required';
  END IF;
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

CREATE OR REPLACE FUNCTION public.seeker_settle_market_buy(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_item_listings%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_buyer_state jsonb;
  v_seller_state jsonb;
  v_inventory jsonb;
  v_buyer_balance numeric;
  v_seller_balance numeric;
  v_seller_proceeds bigint;
  v_fee bigint;
  v_buyer_revision bigint;
  v_seller_revision bigint;
  v_day date := (now() AT TIME ZONE 'Europe/Moscow')::date;
  v_pool_total bigint;
  v_pool_trades integer;
  v_mail_id uuid;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'buy' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_listing FROM public.market_item_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;

  PERFORM player_id FROM public.players
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  PERFORM player_id FROM public.player_saves
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  SELECT state INTO v_buyer_state FROM public.player_saves WHERE player_id = p_player_id;
  SELECT state INTO v_seller_state FROM public.player_saves WHERE player_id = v_listing.seller_id;
  IF v_buyer_state IS NULL OR v_seller_state IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_buyer_state->'inventory', '[]'::jsonb);

  SELECT * INTO v_item FROM public.player_items
    WHERE id = v_listing.item_id AND player_id = v_listing.seller_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  UPDATE public.player_saves SET state = v_buyer_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_buyer_revision;
  UPDATE public.player_saves SET state = v_seller_state, revision = revision + 1, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING revision INTO v_seller_revision;
  UPDATE public.player_items SET player_id = p_player_id WHERE id = v_listing.item_id;
  UPDATE public.market_item_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  v_mail_id := public.mail_deliver_item(p_player_id, v_listing.item_id, 'market_purchase', p_listing_id::text);

  v_result := jsonb_build_object(
    'listing_id', p_listing_id,
    'item', public.market_item_json(v_item),
    'inventory', v_inventory,
    'price', v_listing.price,
    'revision', v_buyer_revision,
    'seller_revision', v_seller_revision,
    'delivered_to', 'mail',
    'mail_id', v_mail_id
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'buy', v_request, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.seeker_settle_store_purchase(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_slot_index integer,
  p_refresh_at bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.store_purchase_events%ROWTYPE;
  v_store public.player_store_state%ROWTYPE;
  v_state jsonb;
  v_revision bigint;
  v_inventory jsonb;
  v_owned jsonb;
  v_offer jsonb;
  v_gold bigint;
  v_price bigint;
  v_bag_count integer;
  v_base_item_id text;
  v_slot text;
  v_rarity text;
  v_rarity_index integer;
  v_rarity_mult numeric[] := ARRAY[0.3,0.7,1.4];
  v_stat_count integer;
  v_stat_pool text[];
  v_stat_key text;
  v_stat_choice integer;
  v_stat_min numeric;
  v_stat_max numeric;
  v_stat_value numeric;
  v_is_percent boolean;
  v_stats jsonb := '[]'::jsonb;
  v_power numeric := 0;
  v_power_weight numeric;
  v_item_id uuid;
  v_item jsonb;
  v_result jsonb;
  j integer;
BEGIN
  IF p_slot_index < 0 OR p_slot_index > 3 THEN RAISE EXCEPTION 'invalid_store_slot'; END IF;
  SELECT * INTO v_existing FROM public.store_purchase_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.slot_index <> p_slot_index OR v_existing.refresh_at <> p_refresh_at THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT * INTO v_existing FROM public.store_purchase_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.slot_index <> p_slot_index OR v_existing.refresh_at <> p_refresh_at THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_store FROM public.player_store_state WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND OR v_store.refresh_at <> p_refresh_at OR v_store.refresh_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint THEN
    RAISE EXCEPTION 'store_offer_expired';
  END IF;

  v_offer := v_store.offers->p_slot_index;
  IF v_offer IS NULL OR COALESCE((v_offer->>'sold')::boolean, false) THEN RAISE EXCEPTION 'store_offer_sold'; END IF;
  v_price := GREATEST(0, floor(COALESCE((v_offer->>'price')::numeric, 0)))::bigint;
  v_gold := GREATEST(0, floor(COALESCE((v_state->>'gold')::numeric, 0)))::bigint;


  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  SELECT count(*) INTO v_bag_count
  FROM jsonb_array_elements(v_inventory) item
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_owned) hero,
      jsonb_each_text(COALESCE(hero->'equipped', '{}'::jsonb)) equipped
    WHERE equipped.value = item->>'uid'
  );


  v_base_item_id := v_offer->>'itemId';
  v_slot := v_offer->>'slot';
  v_rarity := v_offer->>'rarity';
  v_rarity_index := array_position(ARRAY['common','uncommon','rare'], v_rarity);
  IF v_base_item_id IS NULL OR v_slot IS NULL OR v_rarity_index IS NULL THEN RAISE EXCEPTION 'invalid_store_offer'; END IF;
  -- Keep the current V5 item roll and V4 enchant/power representation.
  v_stats := public.roll_item_stats_v5(v_slot,v_rarity,1,v_base_item_id);
  v_power := public.calculate_item_power_v5(v_stats,0);
  v_item_id := gen_random_uuid();
  v_item := jsonb_build_object(
    'uid', v_item_id::text, 'itemId', v_base_item_id, 'level', 1, 'stats', v_stats, 'power', v_power,
    'serverOwned', true, 'enchantLevel', 0, 'enchantStatsVersion', 4, 'itemRollVersion',5,'rerollCount', 0, 'locked', false
  );
  INSERT INTO public.player_items(id, player_id, base_item_id, slot, rarity, item_level, stats, power, locked, reroll_count, enchant_stats_version,item_roll_version,source_kind)
  VALUES (v_item_id, p_player_id, v_base_item_id, v_slot, v_rarity, 1, v_stats,v_power,false,0,4,5,'store');

  IF v_bag_count >= public.inventory_bag_capacity(v_state) THEN
    PERFORM public.mail_deliver_item(p_player_id,v_item_id,'store_overflow',p_idempotency_key::text);
  ELSE
    v_inventory := v_inventory || jsonb_build_array(v_item);
  END IF;
  v_store.offers := jsonb_set(v_store.offers, ARRAY[p_slot_index::text, 'sold'], 'true'::jsonb, false);

  v_state := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_state,
    '{inventory}', v_inventory, true), '{gold}', to_jsonb(v_gold), true),
    '{rotatingShop}', v_store.offers, true), '{rotatingShopRefreshAt}', to_jsonb(v_store.refresh_at), true);
  v_revision := v_revision + 1;
  UPDATE public.player_store_state SET offers = v_store.offers, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = v_state, revision = v_revision, updated_at = now() WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'item', v_item, 'inventory', v_inventory, 'gold', v_gold, 'store', v_store.offers,
    'refresh_at', v_store.refresh_at, 'revision', v_revision, 'slot_index', p_slot_index, 'price', v_price, 'delivered_to', CASE WHEN v_bag_count >= public.inventory_bag_capacity(v_state) THEN 'mail' ELSE 'inventory' END
  );
  INSERT INTO public.store_purchase_events(idempotency_key, player_id, slot_index, refresh_at, result)
  VALUES (p_idempotency_key, p_player_id, p_slot_index, p_refresh_at, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.seeker_settle_hero_ascension(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_uid text,
  p_repeat boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.hero_ascension_events%ROWTYPE;
  v_state jsonb;
  v_owned jsonb;
  v_team jsonb;
  v_training jsonb;
  v_target jsonb;
  v_target_hero_id text;
  v_target_stars integer;
  v_required integer;
  v_rarity text;
  v_base_usd_cents integer;
  v_cost numeric;
  v_total_cost numeric := 0;
  v_total_usd_cents integer := 0;
  v_hero_usd_quote_micros integer := 1000;
  v_balance numeric;
  v_consumed text[] := ARRAY[]::text[];
  v_candidates text[];
  v_stars_added integer := 0;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_target_uid IS NULL OR char_length(p_target_uid) < 1 OR char_length(p_target_uid) > 100 THEN RAISE EXCEPTION 'invalid_target'; END IF;

  SELECT * INTO v_existing FROM public.hero_ascension_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.target_uid <> p_target_uid OR v_existing.repeat_upgrades <> p_repeat THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  PERFORM 1 FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  v_team := COALESCE(v_state->'team', '[]'::jsonb);
  v_training := COALESCE(v_state#>'{trainingCamp,heroUids}', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' OR jsonb_typeof(v_team) <> 'array' OR jsonb_typeof(v_training) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;

  LOOP
    SELECT hero INTO v_target FROM jsonb_array_elements(v_owned) AS hero WHERE hero->>'uid' = p_target_uid LIMIT 1;
    IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;

    v_target_hero_id := v_target->>'heroId';
    v_rarity := substring(v_target_hero_id FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$');
    v_base_usd_cents := CASE v_rarity
      WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3 WHEN 'epic' THEN 5
      WHEN 'legendary' THEN 8 WHEN 'mythic' THEN 12 WHEN 'cosmic' THEN 20
      WHEN 'divine' THEN 30 WHEN 'celestial' THEN 45 ELSE NULL
    END;
    IF v_base_usd_cents IS NULL THEN RAISE EXCEPTION 'unsupported_rarity'; END IF;
    v_target_stars := LEAST(20, GREATEST(0, COALESCE((v_target->>'stars')::integer, 0)));
    IF v_target_stars >= 20 THEN
      IF v_stars_added = 0 THEN RAISE EXCEPTION 'maximum_stars'; END IF;
      EXIT;
    END IF;

    v_required := public.hero_ascension_required_duplicates(v_rarity, v_target_stars);
    v_cost := CEIL((v_base_usd_cents * (v_target_stars + 1) * 10000)::numeric / v_hero_usd_quote_micros);

    SELECT array_agg(candidate.uid ORDER BY candidate.ordinality)
    INTO v_candidates
    FROM (
      SELECT hero->>'uid' AS uid, ordinality
      FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
      WHERE hero->>'heroId' = v_target_hero_id
        AND hero->>'uid' <> p_target_uid
        AND COALESCE((hero->>'stars')::integer, 0) = 0
        AND COALESCE((hero->>'locked')::boolean, false) = false
        AND NOT (v_team ? (hero->>'uid'))
        AND NOT (v_training ? (hero->>'uid'))
      ORDER BY ordinality
      LIMIT v_required
    ) AS candidate;

    IF COALESCE(array_length(v_candidates, 1), 0) < v_required THEN
      IF v_stars_added = 0 THEN RAISE EXCEPTION 'insufficient_duplicates'; END IF;
      EXIT;
    END IF;
    SELECT COALESCE(jsonb_agg(
      CASE WHEN hero->>'uid' = p_target_uid THEN jsonb_set(hero, '{stars}', to_jsonb(v_target_stars + 1), true) ELSE hero END
      ORDER BY ordinality
    ), '[]'::jsonb)
    INTO v_owned
    FROM jsonb_array_elements(v_owned) WITH ORDINALITY AS owned(hero, ordinality)
    WHERE NOT ((hero->>'uid') = ANY(v_candidates));

    v_consumed := v_consumed || v_candidates;


    v_total_usd_cents := v_total_usd_cents + (v_base_usd_cents * (v_target_stars + 1));
    v_stars_added := v_stars_added + 1;
    v_target_stars := v_target_stars + 1;
    EXIT WHEN NOT p_repeat;
  END LOOP;

  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);

  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;

  UPDATE public.players
  SET heroes_owned = jsonb_array_length(v_owned), updated_at = now()
  WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'target_uid', p_target_uid, 'stars_added', v_stars_added, 'target_stars', v_target_stars,
    'consumed_uids', to_jsonb(v_consumed), 'owned_heroes', v_owned, 'spent', v_total_cost,
    'catalogue_usd_cents', v_total_usd_cents, 'hero_usd_quote_micros', v_hero_usd_quote_micros,
    'revision', v_revision
  );

  INSERT INTO public.hero_ascension_events (
    idempotency_key, player_id, target_uid, repeat_upgrades, token_cost,
    catalogue_usd_cents, hero_usd_quote_micros, result
  ) VALUES (
    p_idempotency_key, p_player_id, p_target_uid, p_repeat, v_total_cost,
    v_total_usd_cents, v_hero_usd_quote_micros, v_result
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.seeker_settle_item_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_action_kind text,
  p_item_id uuid,
  p_use_charm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.item_upgrade_events%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_owned jsonb;
  v_item_json jsonb;
  v_next_inventory jsonb;
  v_next_owned jsonb;
  v_revision bigint;
  v_gold bigint;
  v_gold_cost bigint := 0;
  v_token_cost bigint := 0;
  v_chance numeric := 1;
  v_success boolean := true;
  v_destroyed boolean := false;
  v_target integer;
  v_catalogue_usd_micros bigint := 0;
  v_hero_usd_quote_micros integer := 1000;
  v_reroll_base_usd_micros bigint;
  v_stats jsonb;
  v_new_reroll integer;
  v_new_enchant integer;
  v_new_power bigint;
  v_result jsonb;
BEGIN
  IF p_action_kind NOT IN ('enchant', 'reroll') OR (p_action_kind = 'reroll' AND p_use_charm) THEN
    RAISE EXCEPTION 'invalid_item_upgrade';
  END IF;

  SELECT * INTO v_existing
  FROM public.item_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_id <> p_item_id OR v_existing.use_charm <> p_use_charm THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  PERFORM 1
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;

  SELECT * INTO v_existing
  FROM public.item_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_id <> p_item_id OR v_existing.use_charm <> p_use_charm THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_item
  FROM public.player_items
  WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  IF p_action_kind = 'enchant' AND (v_item.enchant_level < 0 OR v_item.enchant_level >= 20) THEN
    RAISE EXCEPTION 'maximum_enchant';
  END IF;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  SELECT entry.value INTO v_item_json
  FROM jsonb_array_elements(v_inventory) entry(value)
  WHERE entry.value->>'uid' = p_item_id::text
  LIMIT 1;
  IF v_item_json IS NULL THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;

  v_item_json := v_item_json || jsonb_build_object(
    'uid', v_item.id,
    'itemId', v_item.base_item_id,
    'level', v_item.item_level,
    'stats', v_item.stats,
    'power', v_item.power,
    'locked', v_item.locked,
    'enchantLevel', v_item.enchant_level,
    'rerollCount', v_item.reroll_count,
    'enchantStatsVersion', 4,
    'itemRollVersion', v_item.item_roll_version,
    'serverOwned', true
  );

  v_gold := GREATEST(0, floor(COALESCE((v_state->>'gold')::numeric, 0)))::bigint;
  v_target := v_item.enchant_level + 1;

  IF p_action_kind = 'reroll' THEN
    v_reroll_base_usd_micros := CASE v_item.rarity
      WHEN 'common' THEN 5000 WHEN 'uncommon' THEN 10000 WHEN 'rare' THEN 20000
      WHEN 'epic' THEN 40000 WHEN 'legendary' THEN 80000 WHEN 'mythic' THEN 150000
      WHEN 'relic' THEN 150000 WHEN 'cosmic' THEN 300000 WHEN 'divine' THEN 600000
      WHEN 'celestial' THEN 1000000 WHEN 'cursed' THEN 1500000
      WHEN 'immortal' THEN 2500000 WHEN 'god' THEN 4000000 ELSE NULL END;
    IF v_reroll_base_usd_micros IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
    v_catalogue_usd_micros := v_reroll_base_usd_micros
      * LEAST(5, GREATEST(1, v_item.reroll_count + 1));
    v_token_cost := ceil(v_catalogue_usd_micros::numeric / v_hero_usd_quote_micros)::bigint;
  ELSE
    v_gold_cost := CASE v_item.rarity
      WHEN 'common' THEN (ARRAY[100,300,800,2000,4000,7000,11000,17000,25000,36000,50000,68000,90000,115000,150000,190000,240000,295000,360000,435000]::bigint[])[v_target]
      WHEN 'uncommon' THEN (ARRAY[150,450,1200,3100,6200,11000,17500,27500,40500,59000,82500,115000,150000,200000,255000,330000,415000,520000,640000,785000]::bigint[])[v_target]
      WHEN 'rare' THEN (ARRAY[200,650,1800,4600,9300,16500,26000,41000,61000,89000,125000,170000,230000,305000,395000,505000,640000,805000,995000,1200000]::bigint[])[v_target]
      WHEN 'epic' THEN (ARRAY[300,1000,2600,6700,13500,24500,39000,61000,91500,135000,190000,260000,350000,465000,605000,780000,995000,1300000,1600000,1900000]::bigint[])[v_target]
      WHEN 'legendary' THEN (ARRAY[500,1500,4200,10500,22000,39000,62500,98500,150000,220000,310000,430000,580000,770000,1000000,1300000,1700000,2100000,2600000,3300000]::bigint[])[v_target]
      WHEN 'mythic' THEN (ARRAY[800,2500,6700,17500,35500,63500,105000,165000,245000,360000,515000,720000,980000,1300000,1700000,2200000,2900000,3600000,4600000,5700000]::bigint[])[v_target]
      WHEN 'relic' THEN (ARRAY[800,2500,6700,17500,35500,63500,105000,165000,245000,360000,515000,720000,980000,1300000,1700000,2200000,2900000,3600000,4600000,5700000]::bigint[])[v_target]
      WHEN 'cosmic' THEN (ARRAY[1300,4000,11000,28500,58000,105000,170000,270000,405000,600000,855000,1200000,1600000,2200000,2900000,3700000,4800000,6100000,7700000,9600000]::bigint[])[v_target]
      WHEN 'divine' THEN (ARRAY[2000,6200,17000,44500,92500,170000,275000,440000,670000,1000000,1400000,2000000,2800000,3800000,5000000,6600000,8500000,11000000,13900000,17400000]::bigint[])[v_target]
      WHEN 'celestial' THEN (ARRAY[3000,9400,26000,68000,140000,255000,420000,680000,1000000,1600000,2300000,3200000,4400000,6000000,8000000,10500000,13700000,17700000,22500000,28300000]::bigint[])[v_target]
      WHEN 'cursed' THEN (ARRAY[4500,14000,39000,100000,215000,390000,635000,1000000,1600000,2400000,3400000,4900000,6700000,9100000,12200000,16100000,21000000,27100000,34500000,43500000]::bigint[])[v_target]
      WHEN 'immortal' THEN (ARRAY[7000,22000,61000,160000,335000,610000,1000000,1600000,2500000,3700000,5400000,7700000,10600000,14400000,19300000,25500000,33400000,43300000,55100000,69600000]::bigint[])[v_target]
      WHEN 'god' THEN (ARRAY[11000,34500,96000,250000,525000,955000,1600000,2500000,3900000,5800000,8500000,12000000,16600000,22600000,30200000,40000000,52300000,67600000,86200000,110000000]::bigint[])[v_target]
      ELSE NULL END;
    IF v_gold_cost IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;

    IF v_target <= 6 THEN
      IF p_use_charm THEN RAISE EXCEPTION 'charm_unavailable'; END IF;
      v_chance := 1;
    ELSE
      v_chance := (ARRAY[.85,.79,.73,.67,.61,.55,.49,.43,.37,.31,.25,.19,.13,.10]::numeric[])[v_target - 6];
      IF p_use_charm THEN
        v_catalogue_usd_micros := (ARRAY[100000,200000,400000,800000,1600000,3000000,6000000,12000000,30000000,80000000,200000000,450000000,700000000,1000000000]::bigint[])[v_target - 6];
        v_token_cost := ceil(v_catalogue_usd_micros::numeric / v_hero_usd_quote_micros)::bigint;
      END IF;
    END IF;
  END IF;

  IF v_gold < v_gold_cost THEN RAISE EXCEPTION 'insufficient_gold'; END IF;


  v_success := p_action_kind = 'reroll' OR p_use_charm OR random() < v_chance;
  v_gold := v_gold - v_gold_cost;

  IF p_action_kind = 'reroll' THEN
    v_stats := public.roll_item_stats_v5(v_item.slot, v_item.rarity, v_item.item_level, v_item.base_item_id);
    v_new_reroll := v_item.reroll_count + 1;
    v_new_power := public.calculate_item_power_v5(v_stats, v_item.enchant_level);
    UPDATE public.player_items
    SET stats = v_stats,
        power = v_new_power,
        reroll_count = v_new_reroll,
        enchant_stats_version = 4,
        item_roll_version = 5
    WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{stats}', v_stats, true), '{power}', to_jsonb(v_new_power), true),
      '{rerollCount}', to_jsonb(v_new_reroll), true), '{enchantStatsVersion}', '4'::jsonb, true), '{itemRollVersion}', '5'::jsonb, true);
  ELSIF v_success THEN
    v_new_enchant := v_target;
    v_new_power := public.calculate_item_power_v4(v_item.stats, v_new_enchant);
    UPDATE public.player_items
    SET enchant_level = v_new_enchant,
        power = v_new_power,
        enchant_stats_version = 4
    WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{enchantLevel}', to_jsonb(v_new_enchant), true),
      '{enchantStatsVersion}', '4'::jsonb, true), '{power}', to_jsonb(v_new_power), true);
  ELSE
    v_destroyed := true;
    UPDATE public.player_items
    SET removed_at = now()
    WHERE id = p_item_id;

    IF v_item.rarity IN ('divine','celestial','cursed','immortal','god') THEN
      UPDATE public.rarity_supply
      SET existing_count = GREATEST(0, existing_count - 1), updated_at = now()
      WHERE rarity = v_item.rarity;
    END IF;
  END IF;

  IF v_destroyed THEN
    SELECT COALESCE(jsonb_agg(entry.value ORDER BY entry.ordinality), '[]'::jsonb)
    INTO v_inventory
    FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(value, ordinality)
    WHERE entry.value->>'uid' <> p_item_id::text;

    SELECT COALESCE(jsonb_agg(jsonb_set(hero.value, '{equipped}', COALESCE((
      SELECT jsonb_object_agg(pair.key, pair.value)
      FROM jsonb_each(COALESCE(hero.value->'equipped', '{}'::jsonb)) pair
      WHERE pair.value #>> '{}' <> p_item_id::text
    ), '{}'::jsonb), true) ORDER BY hero.ordinality), '[]'::jsonb)
    INTO v_next_owned
    FROM jsonb_array_elements(v_owned) WITH ORDINALITY hero(value, ordinality);
    v_owned := v_next_owned;
    v_item_json := NULL;
  ELSE
    SELECT jsonb_agg(CASE WHEN entry.value->>'uid' = p_item_id::text THEN v_item_json ELSE entry.value END ORDER BY entry.ordinality)
    INTO v_next_inventory
    FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(value, ordinality);
    v_inventory := COALESCE(v_next_inventory, '[]'::jsonb);
  END IF;

  v_state := jsonb_set(jsonb_set(jsonb_set(v_state, '{inventory}', v_inventory, true),
    '{ownedHeroes}', v_owned, true), '{gold}', to_jsonb(v_gold), true);

  v_revision := v_revision + 1;
  UPDATE public.player_saves
  SET state = v_state, revision = v_revision, updated_at = now()
  WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'action', p_action_kind,
    'item_id', p_item_id,
    'success', v_success,
    'destroyed', v_destroyed,
    'guaranteed', p_use_charm,
    'success_chance', v_chance,
    'item', v_item_json,
    'inventory', v_inventory,
    'owned_heroes', v_owned,
    'gold', v_gold,

    'gold_cost', v_gold_cost,

    'catalogue_usd_micros', v_catalogue_usd_micros,
    'hero_usd_quote_micros', v_hero_usd_quote_micros,
    'balance_version', 'balance-v4',
    'enchant_config_sha256', '4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359',
    'gold_config_sha256', '889b5048505e913d6bddad218db8425ddcb24196ceedc7e7e8423b6447832495',
    'revision', v_revision
  );

  INSERT INTO public.item_upgrade_events(idempotency_key, player_id, action_kind, item_id, use_charm, result)
  VALUES (p_idempotency_key, p_player_id, p_action_kind, p_item_id, p_use_charm, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_purchase_prepare(p_player uuid,p_key uuid,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.seeker_commerce_requests; v_cents numeric; v_context jsonb; v_listing public.market_item_listings;
 v_store public.player_store_state; v_bundle record; v_offer jsonb; v_step jsonb; v_state jsonb; v_target jsonb; v_item public.player_items; v_previous integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('seeker-purchase:'||p_key::text,0));
 SELECT * INTO r FROM public.seeker_commerce_requests WHERE id=p_key;
 IF FOUND THEN
  IF r.player_id<>p_player OR r.action<>p_action OR r.params<>p_params THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  RETURN jsonb_build_object('context',r.context,'usd_cents',r.usd_cents);
 END IF;
 PERFORM public.assert_account_value_allowed(p_player);
 v_context:=jsonb_build_object('action',p_action,'params',p_params);
 IF p_action='market_list_item' THEN
  IF (p_params->>'price')::bigint NOT BETWEEN 1 AND 100000000 THEN RAISE EXCEPTION 'invalid_market_price'; END IF;
  PERFORM 1 FROM public.player_items WHERE id=(p_params->>'item_id')::uuid AND player_id=p_player AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  v_cents:=2;
 ELSIF p_action='market_buy_listing' THEN
  SELECT * INTO v_listing FROM public.market_item_listings WHERE id=(p_params->>'listing_id')::uuid AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id=p_player THEN RAISE EXCEPTION 'market_self_purchase'; END IF;
  IF public.account_risk_level(v_listing.seller_id) IN ('review','hold') THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  v_cents:=v_listing.price;
  v_context:=v_context||jsonb_build_object('seller_id',v_listing.seller_id);
 ELSIF p_action='store_buy_item' THEN
  SELECT * INTO v_store FROM public.player_store_state WHERE player_id=p_player;
  IF NOT FOUND OR v_store.refresh_at<>(p_params->>'refresh_at')::bigint
     OR v_store.refresh_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'store_offer_expired'; END IF;
  IF (p_params->>'slot_index')::integer NOT BETWEEN 0 AND 3 THEN RAISE EXCEPTION 'invalid_store_slot'; END IF;
  v_offer:=v_store.offers->((p_params->>'slot_index')::integer);
  IF v_offer IS NULL OR (v_offer->>'sold')::boolean THEN RAISE EXCEPTION 'store_offer_sold'; END IF;
  v_cents:=(v_offer->>'price')::numeric/1000;
 ELSIF p_action='shop_bundle_buy' THEN
  SELECT * INTO v_bundle FROM public.shop_bundle_catalog() WHERE bundle=p_params->>'bundle';
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_shop_bundle_purchase'; END IF;
  v_cents:=v_bundle.catalogue_usd_cents;
 ELSIF p_action='inventory_bag_buy' THEN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_step:=public.inventory_bag_next_step(v_state);
  IF v_step IS NULL OR (v_step->>'bag')::integer<>(p_params->>'bag')::integer OR v_step->>'kind'<>p_params->>'kind'
    THEN RAISE EXCEPTION 'bag_step_unavailable'; END IF;
  v_context:=v_context||jsonb_build_object('bag_step',v_step);
  v_cents:=(v_step->>'catalogue_usd_cents')::integer;
 ELSIF p_action='hero_ascend' THEN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  SELECT value INTO v_target FROM jsonb_array_elements(v_state->'ownedHeroes') WHERE value->>'uid'=p_params->>'target_uid';
  IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;
  v_previous:=COALESCE((v_target->>'stars')::integer,0);
  IF v_previous>=20 THEN RAISE EXCEPTION 'maximum_stars'; END IF;
  v_cents:=(CASE substring(v_target->>'heroId' FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$')
   WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3 WHEN 'epic' THEN 5 WHEN 'legendary' THEN 8
   WHEN 'mythic' THEN 12 WHEN 'cosmic' THEN 20 WHEN 'divine' THEN 30 WHEN 'celestial' THEN 45 END)*(v_previous+1);
  IF v_cents IS NULL THEN RAISE EXCEPTION 'unsupported_rarity'; END IF;
  v_context:=v_context||jsonb_build_object('previous_stars',v_previous);
 ELSIF p_action='hero_capacity_upgrade' THEN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  v_previous:=COALESCE((v_state->>'heroCapacity')::integer,500);
  IF v_previous<500 OR v_previous>=1000 OR v_previous%100<>0 THEN RAISE EXCEPTION 'hero_capacity_exceeded'; END IF;
  IF v_previous<>(p_params->>'previous_capacity')::integer THEN RAISE EXCEPTION 'hero_capacity_quote_stale'; END IF;
  v_cents:=(v_previous-400);
  v_context:=v_context||jsonb_build_object('previous_capacity',v_previous);
 ELSIF p_action='item_upgrade' THEN
  SELECT * INTO v_item FROM public.player_items WHERE id=(p_params->>'item_uid')::uuid AND player_id=p_player AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF p_params->>'operation'='reroll' AND NOT (p_params->>'use_charm')::boolean THEN
   v_cents:=(CASE v_item.rarity WHEN 'common' THEN .5 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2
    WHEN 'epic' THEN 4 WHEN 'legendary' THEN 8 WHEN 'mythic' THEN 15 WHEN 'relic' THEN 15 WHEN 'cosmic' THEN 30
    WHEN 'divine' THEN 60 WHEN 'celestial' THEN 100 WHEN 'cursed' THEN 150 WHEN 'immortal' THEN 250 WHEN 'god' THEN 400 END)
    *least(5,greatest(1,v_item.reroll_count+1));
  ELSIF p_params->>'operation'='enchant' AND (p_params->>'use_charm')::boolean AND v_item.enchant_level BETWEEN 6 AND 19 THEN
   v_cents:=(ARRAY[10,20,40,80,160,300,600,1200,3000,8000,20000,45000,70000,100000]::numeric[])[v_item.enchant_level-5];
  ELSE RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  IF v_cents IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  v_context:=v_context||jsonb_build_object('previous_enchant',v_item.enchant_level,'previous_reroll',v_item.reroll_count);
 ELSIF p_action='reward_boost_buy' THEN
  SELECT catalogue_usd_cents INTO v_cents FROM public.reward_boost_plan(p_params->>'plan');
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_reward_boost_purchase'; END IF;
 ELSE RAISE EXCEPTION 'invalid_skr_product';
 END IF;
 INSERT INTO public.seeker_commerce_requests(id,player_id,action,params,context,usd_cents)
 VALUES(p_key,p_player,p_action,p_params,v_context,v_cents);
 RETURN jsonb_build_object('context',v_context,'usd_cents',v_cents);
END $$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_purchase_deliver(p_player uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.seeker_commerce_requests; v_result jsonb; v_save public.player_saves;
 v_resource jsonb; v_bundle record; v_step jsonb; v_duration interval; v_expires timestamptz; v_code text; v_target jsonb;
BEGIN
 SELECT * INTO r FROM public.seeker_commerce_requests WHERE id=p_key AND player_id=p_player FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'skr_quote_not_found'; END IF;
 IF r.status<>'prepared' THEN RETURN jsonb_build_object('status',r.status,'result',r.result); END IF;
 -- A subtransaction rolls back every grant before recording a definitive refusal.
 BEGIN
  PERFORM public.assert_account_value_allowed(p_player);
  IF r.action='market_list_item' THEN
   v_result:=public.seeker_settle_market_list(p_player,p_key,(r.params->>'item_id')::uuid,(r.params->>'price')::bigint);
  ELSIF r.action='market_buy_listing' THEN
   IF public.account_risk_level((r.context->>'seller_id')::uuid) IN ('review','hold') THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
   -- The listing seller and price must still equal the server-prepared quote.
   PERFORM 1 FROM public.market_item_listings WHERE id=(r.params->>'listing_id')::uuid
    AND seller_id=(r.context->>'seller_id')::uuid AND price=r.usd_cents AND status='active' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
   v_result:=public.seeker_settle_market_buy(p_player,p_key,(r.params->>'listing_id')::uuid);
  ELSIF r.action='store_buy_item' THEN
   v_result:=public.seeker_settle_store_purchase(p_player,p_key,(r.params->>'slot_index')::integer,(r.params->>'refresh_at')::bigint);
  ELSIF r.action='shop_bundle_buy' THEN
   SELECT * INTO v_bundle FROM public.shop_bundle_catalog() WHERE bundle=r.params->>'bundle';
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
   v_resource:=public.apply_resource_entries(p_player,p_key,'shop_bundle_buy',
    encode(extensions.digest(('seeker-shop:'||p_key::text)::bytea,'sha256'),'hex'),
    jsonb_build_array(jsonb_build_object('resource_id',v_bundle.resource_id,'delta',v_bundle.quantity::text,'source_key','shop_bundle')),v_save.revision+1);
   v_save.state:=jsonb_set(v_save.state,'{summonScrolls}',v_resource#>'{balances,summon_scroll}',true);
   v_save.state:=jsonb_set(v_save.state,'{bossKeys}',v_resource#>'{balances,boss_key}',true);
   v_save.state:=jsonb_set(v_save.state,'{potions}',COALESCE(v_save.state->'potions','{}'::jsonb)||jsonb_build_object(
    'xs',(v_resource#>>'{balances,potion_xs}')::bigint,'sm',(v_resource#>>'{balances,potion_sm}')::bigint,
    'md',(v_resource#>>'{balances,potion_md}')::bigint,'lg',(v_resource#>>'{balances,potion_lg}')::bigint,
    'xl',(v_resource#>>'{balances,potion_xl}')::bigint,'xxl',(v_resource#>>'{balances,potion_xxl}')::bigint),true);
   UPDATE public.players SET boss_keys=(v_resource#>>'{balances,boss_key}')::integer WHERE player_id=p_player;
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('state',v_save.state,'revision',v_save.revision,'bundle',r.params->>'bundle');
  ELSIF r.action='inventory_bag_buy' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
   v_step:=public.inventory_bag_next_step(v_save.state);
   IF v_step IS DISTINCT FROM r.context->'bag_step' THEN RAISE EXCEPTION 'bag_step_unavailable'; END IF;
   v_save.state:=jsonb_set(v_save.state,'{bagSlots}',jsonb_set(COALESCE(v_save.state->'bagSlots','[64,0,0,0]'::jsonb),
     ARRAY[((v_step->>'bag')::integer-1)::text],v_step->'slots'),true);
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('bag_slots',v_save.state->'bagSlots','revision',v_save.revision);
  ELSIF r.action='hero_ascend' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   SELECT value INTO v_target FROM jsonb_array_elements(v_save.state->'ownedHeroes') WHERE value->>'uid'=r.params->>'target_uid';
   IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;
   IF COALESCE((v_target->>'stars')::integer,0)<>(r.context->>'previous_stars')::integer THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
   v_result:=public.seeker_settle_hero_ascension(p_player,p_key,r.params->>'target_uid',false);
  ELSIF r.action='hero_capacity_upgrade' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF COALESCE((v_save.state->>'heroCapacity')::integer,500)<>(r.context->>'previous_capacity')::integer THEN RAISE EXCEPTION 'hero_capacity_quote_stale'; END IF;
   v_save.state:=jsonb_set(v_save.state,'{heroCapacity}',to_jsonb((r.context->>'previous_capacity')::integer+100),true);
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('hero_capacity',v_save.state->'heroCapacity','revision',v_save.revision);
  ELSIF r.action='item_upgrade' THEN
   PERFORM 1 FROM public.player_items WHERE id=(r.params->>'item_uid')::uuid AND player_id=p_player AND removed_at IS NULL
     AND enchant_level=(r.context->>'previous_enchant')::integer AND reroll_count=(r.context->>'previous_reroll')::integer FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
   v_result:=public.seeker_settle_item_upgrade(p_player,p_key,r.params->>'operation',(r.params->>'item_uid')::uuid,(r.params->>'use_charm')::boolean);
  ELSIF r.action='reward_boost_buy' THEN
   SELECT duration INTO v_duration FROM public.reward_boost_plan(r.params->>'plan');
   PERFORM 1 FROM public.players WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
   INSERT INTO public.player_account_bonuses(player_id,source_key,granted_at,expires_at,grant_reason)
   VALUES(p_player,'reward_boost',now(),now()+v_duration,'purchase:skr-reward-boost')
   ON CONFLICT(player_id,source_key) DO UPDATE SET revoked_at=NULL,
    expires_at=CASE WHEN player_account_bonuses.revoked_at IS NULL AND player_account_bonuses.expires_at>now()
       THEN player_account_bonuses.expires_at ELSE now() END+v_duration,
    grant_reason='purchase:skr-reward-boost' RETURNING expires_at INTO v_expires;
   v_result:=jsonb_build_object('boost_expires_at',v_expires,'bonus',public.account_reward_bonus(p_player));
  END IF;
 EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS v_code=MESSAGE_TEXT;
  IF v_code NOT IN ('market_listing_unavailable','market_self_purchase','market_seller_limit_reached',
   'market_test_item_required','item_not_found','item_locked','item_equipped','item_state_mismatch','save_not_found',
   'skr_product_changed','target_not_found','maximum_stars','insufficient_duplicates','unsupported_rarity','invalid_save_state','hero_capacity_quote_stale','maximum_enchant','insufficient_gold','invalid_item_upgrade','account_not_found','account_restricted','bag_step_unavailable','idempotency_conflict','player_not_found','store_offer_expired','store_offer_sold','invalid_store_slot','resource_balance_cap') THEN RAISE; END IF;
  UPDATE public.seeker_commerce_requests SET status='rejected',result=jsonb_build_object('code',v_code) WHERE id=p_key;
  RETURN jsonb_build_object('status','rejected','result',jsonb_build_object('code',v_code));
 END;
 UPDATE public.seeker_commerce_requests SET status='delivered',result=v_result WHERE id=p_key;
 RETURN jsonb_build_object('status','delivered','result',v_result);
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_hero_ascension(uuid,uuid,text,boolean),public.seeker_settle_item_upgrade(uuid,uuid,text,uuid,boolean),public.seeker_settle_market_list(uuid,uuid,uuid,bigint),
 public.seeker_settle_market_buy(uuid,uuid,uuid),public.seeker_settle_store_purchase(uuid,uuid,integer,bigint),
 heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb),heroloop_api.seeker_purchase_deliver(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb),
 heroloop_api.seeker_purchase_deliver(uuid,uuid) TO heroloop_api;
COMMIT;
-- Bind withdrawal destinations and Founder authority to a verified active identity.
CREATE OR REPLACE FUNCTION heroloop_api.seeker_wallet_identity(p_player uuid,p_address text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,heroloop_api AS $$
 SELECT jsonb_build_object('verified',EXISTS(SELECT 1 FROM heroloop_api.account_identities i
  JOIN heroloop_api.heroloop_accounts a ON a.account_id=i.account_id
  WHERE i.account_id=p_player AND i.provider='solana' AND i.provider_subject=p_address AND i.state='active' AND a.state='active'))
$$;
REVOKE ALL ON FUNCTION heroloop_api.seeker_wallet_identity(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_wallet_identity(uuid,text) TO heroloop_api;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_bag_snapshot(p_player uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE(public.inventory_bag_next_step(state)||jsonb_build_object('available',true,'token_cost',0),
  jsonb_build_object('complete',true)) FROM public.player_saves WHERE player_id=p_player
$$;
REVOKE ALL ON FUNCTION heroloop_api.seeker_bag_snapshot(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_bag_snapshot(uuid) TO heroloop_api;
