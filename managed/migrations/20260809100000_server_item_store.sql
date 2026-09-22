CREATE TABLE IF NOT EXISTS public.player_store_state (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  offers jsonb NOT NULL,
  refresh_at bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.store_purchase_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 0 AND 3),
  refresh_at bigint NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_purchase_events_player_created_idx
  ON public.store_purchase_events (player_id, created_at DESC);

ALTER TABLE public.player_store_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_purchase_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_store_state, public.store_purchase_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.player_store_state, public.store_purchase_events TO service_role;

CREATE OR REPLACE FUNCTION public.generate_store_offers()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_rarities text[] := ARRAY['common','uncommon','uncommon','rare'];
  v_price_bases integer[] := ARRAY[80,250,250,800];
  v_result jsonb := '[]'::jsonb;
  v_catalog_index integer;
  v_item_id text;
  v_slot text;
  i integer;
BEGIN
  FOR i IN 1..4 LOOP
    v_catalog_index := floor(random() * 16)::integer;
    IF v_catalog_index < 5 THEN
      v_slot := 'class_weapon';
      v_item_id := 'weapon-' || (ARRAY['mage','assassin','warrior','druid','crossbowman'])[v_catalog_index + 1] || '-' || v_rarities[i];
    ELSIF v_catalog_index < 10 THEN
      v_slot := 'offhand';
      v_item_id := 'offhand-' || (ARRAY['mage','assassin','warrior','druid','crossbowman'])[v_catalog_index - 4] || '-' || v_rarities[i];
    ELSE
      v_slot := (ARRAY['helmet','chest','gloves','boots','amulet','ring'])[v_catalog_index - 9];
      v_item_id := (ARRAY['helmet','armor','gloves','boots','amulet','ring'])[v_catalog_index - 9] || '-' || v_rarities[i];
    END IF;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id,
      'price', v_price_bases[i] + floor(random() * v_price_bases[i] * 0.4)::integer,
      'sold', false,
      'rarity', v_rarities[i],
      'slot', v_slot
    ));
  END LOOP;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_store_offers() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.store_snapshot(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_gold bigint;
  v_store public.player_store_state%ROWTYPE;
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  v_changed boolean := false;
BEGIN
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  INSERT INTO public.player_store_state(player_id, offers, refresh_at)
  VALUES (p_player_id, public.generate_store_offers(), v_now_ms + 14400000)
  ON CONFLICT (player_id) DO NOTHING;
  SELECT * INTO v_store FROM public.player_store_state WHERE player_id = p_player_id FOR UPDATE;

  IF v_store.refresh_at <= v_now_ms THEN
    v_store.offers := public.generate_store_offers();
    v_store.refresh_at := v_now_ms + 14400000;
    UPDATE public.player_store_state
    SET offers = v_store.offers, refresh_at = v_store.refresh_at, updated_at = now()
    WHERE player_id = p_player_id;
  END IF;

  IF COALESCE(v_state->'rotatingShop', 'null'::jsonb) IS DISTINCT FROM v_store.offers
    OR COALESCE((v_state->>'rotatingShopRefreshAt')::bigint, 0) <> v_store.refresh_at THEN
    v_state := jsonb_set(jsonb_set(v_state, '{rotatingShop}', v_store.offers, true), '{rotatingShopRefreshAt}', to_jsonb(v_store.refresh_at), true);
    v_revision := v_revision + 1;
    UPDATE public.player_saves SET state = v_state, revision = v_revision, updated_at = now() WHERE player_id = p_player_id;
    v_changed := true;
  END IF;
  v_gold := GREATEST(0, floor(COALESCE((v_state->>'gold')::numeric, 0)))::bigint;
  RETURN jsonb_build_object('store', v_store.offers, 'refresh_at', v_store.refresh_at, 'gold', v_gold, 'revision', v_revision, 'changed', v_changed);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_store_purchase(
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
  IF v_gold < v_price THEN RAISE EXCEPTION 'insufficient_gold'; END IF;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  SELECT count(*) INTO v_bag_count
  FROM jsonb_array_elements(v_inventory) item
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_owned) hero,
      jsonb_each_text(COALESCE(hero->'equipped', '{}'::jsonb)) equipped
    WHERE equipped.value = item->>'uid'
  );
  IF v_bag_count >= 64 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;

  v_base_item_id := v_offer->>'itemId';
  v_slot := v_offer->>'slot';
  v_rarity := v_offer->>'rarity';
  v_rarity_index := array_position(ARRAY['common','uncommon','rare'], v_rarity);
  IF v_base_item_id IS NULL OR v_slot IS NULL OR v_rarity_index IS NULL THEN RAISE EXCEPTION 'invalid_store_offer'; END IF;
  v_stat_count := (ARRAY[1,1,2])[v_rarity_index];
  v_stat_pool := CASE v_slot
    WHEN 'class_weapon' THEN ARRAY['atk','critChance','critDamage','atkSpeed','hp','goldBonus']
    WHEN 'offhand' THEN ARRAY['def','hp','critChance','critDamage','dodge','xpBonus']
    WHEN 'chest' THEN ARRAY['hp','def','atk','goldBonus','dodge','critDamage']
    WHEN 'ring' THEN ARRAY['goldBonus','xpBonus','critChance','hp','atk','dodge']
    WHEN 'helmet' THEN ARRAY['hp','def','critChance','xpBonus','atk','dodge']
    WHEN 'gloves' THEN ARRAY['atk','critChance','critDamage','def','atkSpeed','hp']
    WHEN 'boots' THEN ARRAY['atkSpeed','dodge','def','hp','goldBonus','critChance']
    ELSE ARRAY['xpBonus','goldBonus','hp','critDamage','dodge','def']
  END;
  FOR j IN 1..v_stat_count LOOP
    v_stat_choice := 1 + floor(random() * array_length(v_stat_pool, 1))::integer;
    v_stat_key := v_stat_pool[v_stat_choice];
    v_stat_pool := array_remove(v_stat_pool, v_stat_key);
    SELECT stat_min, stat_max INTO v_stat_min, v_stat_max FROM (VALUES
      ('hp',8::numeric,20::numeric), ('atk',2,5), ('def',1,4), ('atkSpeed',3,8),
      ('critChance',0.005,0.015), ('critDamage',0.02,0.06), ('goldBonus',0.01,0.03),
      ('xpBonus',0.01,0.03), ('dodge',0.005,0.015)
    ) AS ranges(stat_key, stat_min, stat_max) WHERE stat_key = v_stat_key;
    v_stat_value := (v_stat_min + random() * (v_stat_max - v_stat_min)) * v_rarity_mult[v_rarity_index];
    v_is_percent := v_stat_key IN ('critChance','critDamage','goldBonus','xpBonus','dodge');
    v_stat_value := CASE WHEN v_is_percent THEN round(v_stat_value, 3) ELSE round(v_stat_value) END;
    v_stats := v_stats || jsonb_build_array(jsonb_build_object('key', v_stat_key, 'value', v_stat_value, 'isPercent', v_is_percent));
    v_power_weight := CASE v_stat_key
      WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN 0.5
      WHEN 'hp' THEN 0.15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100 WHEN 'dodge' THEN 150 ELSE 1 END;
    v_power := v_power + v_stat_value * v_power_weight;
  END LOOP;
  v_power := round(v_power);
  v_item_id := gen_random_uuid();
  v_item := jsonb_build_object(
    'uid', v_item_id::text, 'itemId', v_base_item_id, 'level', 1, 'stats', v_stats, 'power', v_power,
    'serverOwned', true, 'enchantLevel', 0, 'enchantStatsVersion', 2, 'rerollCount', 0, 'locked', false
  );
  INSERT INTO public.player_items(id, player_id, base_item_id, slot, rarity, item_level, stats, power, locked, reroll_count, enchant_stats_version, source_kind)
  VALUES (v_item_id, p_player_id, v_base_item_id, v_slot, v_rarity, 1, v_stats, v_power, false, 0, 2, 'store');

  v_inventory := v_inventory || jsonb_build_array(v_item);
  v_store.offers := jsonb_set(v_store.offers, ARRAY[p_slot_index::text, 'sold'], 'true'::jsonb, false);
  v_gold := v_gold - v_price;
  v_state := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_state,
    '{inventory}', v_inventory, true), '{gold}', to_jsonb(v_gold), true),
    '{rotatingShop}', v_store.offers, true), '{rotatingShopRefreshAt}', to_jsonb(v_store.refresh_at), true);
  v_revision := v_revision + 1;
  UPDATE public.player_store_state SET offers = v_store.offers, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = v_state, revision = v_revision, updated_at = now() WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'item', v_item, 'inventory', v_inventory, 'gold', v_gold, 'store', v_store.offers,
    'refresh_at', v_store.refresh_at, 'revision', v_revision, 'slot_index', p_slot_index, 'price', v_price
  );
  INSERT INTO public.store_purchase_events(idempotency_key, player_id, slot_index, refresh_at, result)
  VALUES (p_idempotency_key, p_player_id, p_slot_index, p_refresh_at, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.store_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_store_purchase(uuid, uuid, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_snapshot(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_store_purchase(uuid, uuid, integer, bigint) TO service_role;
