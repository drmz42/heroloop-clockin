CREATE TABLE IF NOT EXISTS public.item_upgrade_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  action_kind text NOT NULL CHECK (action_kind IN ('enchant', 'reroll')),
  item_id uuid NOT NULL,
  use_charm boolean NOT NULL DEFAULT false,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS item_upgrade_events_player_created_idx
  ON public.item_upgrade_events (player_id, created_at DESC);

ALTER TABLE public.item_upgrade_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.item_upgrade_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.item_upgrade_events TO service_role;

CREATE OR REPLACE FUNCTION public.roll_item_stats(p_slot text, p_rarity text, p_item_level integer)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_rarity_index integer;
  v_stat_counts integer[] := ARRAY[1,1,2,2,3,3,4,4,5,5,6,6,3];
  v_rarity_mult numeric[] := ARRAY[0.3,0.7,1.4,2.8,4.6,6.5,9,13,18,0,0,0,6.5];
  v_stat_pool text[];
  v_stat_key text;
  v_choice integer;
  v_min numeric;
  v_max numeric;
  v_value numeric;
  v_percent boolean;
  v_result jsonb := '[]'::jsonb;
  i integer;
BEGIN
  v_rarity_index := array_position(
    ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial','cursed','immortal','god','relic'],
    p_rarity
  );
  IF v_rarity_index IS NULL OR p_item_level < 1 THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  v_stat_pool := CASE p_slot
    WHEN 'class_weapon' THEN ARRAY['atk','critChance','critDamage','atkSpeed','hp','goldBonus']
    WHEN 'weapon' THEN ARRAY['atk','critChance','critDamage','atkSpeed','hp','goldBonus']
    WHEN 'offhand' THEN ARRAY['def','hp','critChance','critDamage','dodge','xpBonus']
    WHEN 'chest' THEN ARRAY['hp','def','atk','goldBonus','dodge','critDamage']
    WHEN 'armor' THEN ARRAY['hp','def','atk','goldBonus','dodge','critDamage']
    WHEN 'ring' THEN ARRAY['goldBonus','xpBonus','critChance','hp','atk','dodge']
    WHEN 'ring1' THEN ARRAY['goldBonus','xpBonus','critChance','hp','atk','dodge']
    WHEN 'ring2' THEN ARRAY['critDamage','atk','goldBonus','critChance','def','xpBonus']
    WHEN 'helmet' THEN ARRAY['hp','def','critChance','xpBonus','atk','dodge']
    WHEN 'gloves' THEN ARRAY['atk','critChance','critDamage','def','atkSpeed','hp']
    WHEN 'boots' THEN ARRAY['atkSpeed','dodge','def','hp','goldBonus','critChance']
    WHEN 'amulet' THEN ARRAY['xpBonus','goldBonus','hp','critDamage','dodge','def']
    ELSE NULL
  END;
  IF v_stat_pool IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  FOR i IN 1..v_stat_counts[v_rarity_index] LOOP
    v_choice := 1 + floor(random() * array_length(v_stat_pool, 1))::integer;
    v_stat_key := v_stat_pool[v_choice];
    v_stat_pool := array_remove(v_stat_pool, v_stat_key);
    SELECT stat_min, stat_max INTO v_min, v_max FROM (VALUES
      ('hp',8::numeric,20::numeric), ('atk',2,5), ('def',1,4), ('atkSpeed',3,8),
      ('critChance',0.005,0.015), ('critDamage',0.02,0.06), ('goldBonus',0.01,0.03),
      ('xpBonus',0.01,0.03), ('dodge',0.005,0.015)
    ) AS ranges(stat_key, stat_min, stat_max) WHERE stat_key = v_stat_key;
    v_value := (v_min + random() * (v_max - v_min))
      * v_rarity_mult[v_rarity_index] * (1 + (p_item_level - 1) * 0.03);
    v_percent := v_stat_key IN ('critChance','critDamage','goldBonus','xpBonus','dodge');
    v_value := CASE WHEN v_percent THEN round(v_value, 3) ELSE round(v_value) END;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'key', v_stat_key, 'value', v_value, 'isPercent', v_percent
    ));
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_item_power(p_stats jsonb, p_enchant_level integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT round(COALESCE(sum(
    COALESCE((stat->>'value')::numeric, 0) * CASE stat->>'key'
      WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN 0.5
      WHEN 'hp' THEN 0.15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100 WHEN 'dodge' THEN 150
      ELSE 1 END
  ), 0) * (1 + GREATEST(0, p_enchant_level) * 0.10))::bigint
  FROM jsonb_array_elements(COALESCE(p_stats, '[]'::jsonb)) stat;
$$;

REVOKE ALL ON FUNCTION public.roll_item_stats(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calculate_item_power(jsonb, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_item_upgrade(
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
  v_next_inventory jsonb;
  v_next_owned jsonb;
  v_item_json jsonb;
  v_stats jsonb;
  v_revision bigint;
  v_gold bigint;
  v_token_balance numeric;
  v_token_spent numeric;
  v_gold_cost bigint := 0;
  v_token_cost bigint := 0;
  v_success boolean := true;
  v_destroyed boolean := false;
  v_chance numeric := 1;
  v_new_enchant integer;
  v_new_reroll integer;
  v_new_power bigint;
  v_reroll_base bigint;
  v_result jsonb;
BEGIN
  IF p_action_kind NOT IN ('enchant', 'reroll') THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  IF p_action_kind = 'reroll' AND p_use_charm THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;

  SELECT * INTO v_existing FROM public.item_upgrade_events WHERE idempotency_key = p_idempotency_key;
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
  SELECT token_balance, boost_tokens_spent INTO v_token_balance, v_token_spent
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
  SELECT * INTO v_existing FROM public.item_upgrade_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_id <> p_item_id OR v_existing.use_charm <> p_use_charm THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_item FROM public.player_items
  WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  SELECT entry.item INTO v_item_json
  FROM jsonb_array_elements(v_inventory) entry(item)
  WHERE entry.item->>'uid' = p_item_id::text LIMIT 1;
  IF v_item_json IS NULL THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;
  v_item_json := v_item_json || jsonb_build_object(
    'uid', v_item.id, 'itemId', v_item.base_item_id, 'level', v_item.item_level,
    'stats', v_item.stats, 'power', v_item.power, 'locked', v_item.locked,
    'enchantLevel', v_item.enchant_level, 'rerollCount', v_item.reroll_count,
    'enchantStatsVersion', v_item.enchant_stats_version, 'serverOwned', true
  );
  v_gold := GREATEST(0, floor(COALESCE((v_state->>'gold')::numeric, 0)))::bigint;

  IF p_action_kind = 'enchant' THEN
    IF v_item.enchant_level < 0 OR v_item.enchant_level >= 10 THEN RAISE EXCEPTION 'maximum_enchant'; END IF;
    v_gold_cost := (ARRAY[50,100,200,400,800,1600,3200,6400,12800,25600])[v_item.enchant_level + 1];
    v_chance := (ARRAY[1.0,1.0,1.0,0.85,0.70,0.55,0.40,0.25,0.15,0.10]::numeric[])[v_item.enchant_level + 1];
    IF p_use_charm THEN
      IF v_item.enchant_level < 3 THEN RAISE EXCEPTION 'charm_unavailable'; END IF;
      v_token_cost := (ARRAY[1,2,5,10,20,35,50])[v_item.enchant_level - 2];
    END IF;
    IF v_gold < v_gold_cost THEN RAISE EXCEPTION 'insufficient_gold'; END IF;
    IF v_token_balance < v_token_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
    v_success := p_use_charm OR random() < v_chance;
    v_gold := v_gold - v_gold_cost;
    IF v_success THEN
      v_new_enchant := v_item.enchant_level + 1;
      v_new_power := public.calculate_item_power(v_item.stats, v_new_enchant);
      UPDATE public.player_items SET enchant_level = v_new_enchant, power = v_new_power WHERE id = p_item_id;
      v_item_json := jsonb_set(jsonb_set(jsonb_set(v_item_json,
        '{enchantLevel}', to_jsonb(v_new_enchant), true),
        '{enchantStatsVersion}', '2'::jsonb, true), '{power}', to_jsonb(v_new_power), true);
      SELECT jsonb_agg(CASE WHEN entry.item->>'uid' = p_item_id::text THEN v_item_json ELSE entry.item END ORDER BY entry.ordinality)
      INTO v_next_inventory FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(item, ordinality);
      v_inventory := COALESCE(v_next_inventory, '[]'::jsonb);
    ELSE
      v_destroyed := true;
      SELECT COALESCE(jsonb_agg(entry.item ORDER BY entry.ordinality), '[]'::jsonb)
      INTO v_inventory FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(item, ordinality)
      WHERE entry.item->>'uid' <> p_item_id::text;
      SELECT COALESCE(jsonb_agg(jsonb_set(hero.item, '{equipped}', COALESCE((
        SELECT jsonb_object_agg(pair.key, pair.value)
        FROM jsonb_each(COALESCE(hero.item->'equipped', '{}'::jsonb)) pair
        WHERE pair.value #>> '{}' <> p_item_id::text
      ), '{}'::jsonb), true) ORDER BY hero.ordinality), '[]'::jsonb)
      INTO v_next_owned FROM jsonb_array_elements(v_owned) WITH ORDINALITY hero(item, ordinality);
      v_owned := v_next_owned;
      UPDATE public.player_items SET removed_at = now() WHERE id = p_item_id;
      IF v_item.rarity IN ('divine','celestial','cursed','immortal','god') THEN
        UPDATE public.rarity_supply SET existing_count = GREATEST(0, existing_count - 1), updated_at = now()
        WHERE rarity = v_item.rarity;
      END IF;
      v_item_json := NULL;
    END IF;
  ELSE
    v_reroll_base := CASE v_item.rarity
      WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 4 WHEN 'epic' THEN 8
      WHEN 'legendary' THEN 15 WHEN 'mythic' THEN 25 WHEN 'relic' THEN 40 WHEN 'cursed' THEN 60
      WHEN 'cosmic' THEN 90 WHEN 'divine' THEN 150 WHEN 'celestial' THEN 300 WHEN 'immortal' THEN 600
      WHEN 'god' THEN 1200 ELSE NULL END;
    IF v_reroll_base IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
    v_token_cost := round(v_reroll_base * (1 + v_item.reroll_count * 1.5))::bigint;
    IF v_token_balance < v_token_cost THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
    v_stats := public.roll_item_stats(v_item.slot, v_item.rarity, v_item.item_level);
    v_new_reroll := v_item.reroll_count + 1;
    v_new_power := public.calculate_item_power(v_stats, v_item.enchant_level);
    UPDATE public.player_items
    SET stats = v_stats, power = v_new_power, reroll_count = v_new_reroll, enchant_stats_version = 2
    WHERE id = p_item_id;
    v_item_json := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_item_json,
      '{stats}', v_stats, true), '{power}', to_jsonb(v_new_power), true),
      '{rerollCount}', to_jsonb(v_new_reroll), true), '{enchantStatsVersion}', '2'::jsonb, true);
    SELECT jsonb_agg(CASE WHEN entry.item->>'uid' = p_item_id::text THEN v_item_json ELSE entry.item END ORDER BY entry.ordinality)
    INTO v_next_inventory FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(item, ordinality);
    v_inventory := COALESCE(v_next_inventory, '[]'::jsonb);
  END IF;

  IF v_token_cost > 0 THEN
    v_token_balance := v_token_balance - v_token_cost;
    v_token_spent := v_token_spent + v_token_cost;
    UPDATE public.players SET token_balance = v_token_balance, boost_tokens_spent = v_token_spent, updated_at = now()
    WHERE player_id = p_player_id;
    INSERT INTO public.token_spend_events(idempotency_key, player_id, amount, action_kind)
    VALUES (p_idempotency_key, p_player_id, v_token_cost, CASE WHEN p_action_kind = 'reroll' THEN 'item-reroll' ELSE 'enchant-charm' END);
  END IF;
  v_state := jsonb_set(jsonb_set(jsonb_set(v_state, '{inventory}', v_inventory, true),
    '{ownedHeroes}', v_owned, true), '{gold}', to_jsonb(v_gold), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_token_balance), true);
  v_revision := v_revision + 1;
  UPDATE public.player_saves SET state = v_state, revision = v_revision, updated_at = now() WHERE player_id = p_player_id;

  v_result := jsonb_build_object(
    'action', p_action_kind, 'item_id', p_item_id, 'success', v_success, 'destroyed', v_destroyed,
    'item', v_item_json, 'inventory', v_inventory, 'owned_heroes', v_owned,
    'gold', v_gold, 'token_balance', v_token_balance, 'gold_cost', v_gold_cost,
    'token_cost', v_token_cost, 'revision', v_revision
  );
  INSERT INTO public.item_upgrade_events(idempotency_key, player_id, action_kind, item_id, use_charm, result)
  VALUES (p_idempotency_key, p_player_id, p_action_kind, p_item_id, p_use_charm, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean) TO service_role;
