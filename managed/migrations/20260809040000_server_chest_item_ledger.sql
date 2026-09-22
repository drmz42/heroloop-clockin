ALTER TABLE public.player_items
  ADD COLUMN IF NOT EXISTS power bigint NOT NULL DEFAULT 0 CHECK (power >= 0),
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reroll_count integer NOT NULL DEFAULT 0 CHECK (reroll_count >= 0),
  ADD COLUMN IF NOT EXISTS enchant_stats_version integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS source_chest_id text;

CREATE TABLE IF NOT EXISTS public.chest_open_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  chest_count integer NOT NULL CHECK (chest_count BETWEEN 1 AND 64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chest_open_events_player_created_idx
  ON public.chest_open_events (player_id, created_at DESC);

ALTER TABLE public.chest_open_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chest_open_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.player_items TO service_role;

CREATE OR REPLACE FUNCTION public.advance_chest_quests(
  p_quests jsonb,
  p_count integer,
  p_milestone boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN COALESCE((quest->>'claimed')::boolean, false) = false
        AND ((quest->>'id') LIKE 'chest-%' OR quest->>'chain' = 'chest')
      THEN jsonb_set(
        quest,
        '{progress}',
        to_jsonb(CASE
          WHEN p_milestone THEN COALESCE((quest->>'progress')::integer, 0) + p_count
          ELSE LEAST(COALESCE((quest->>'target')::integer, 0), COALESCE((quest->>'progress')::integer, 0) + p_count)
        END),
        true
      )
      ELSE quest
    END
    ORDER BY ordinal
  ), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_quests) = 'array' THEN p_quests ELSE '[]'::jsonb END)
    WITH ORDINALITY AS entries(quest, ordinal);
$$;

CREATE OR REPLACE FUNCTION public.settle_chest_open(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.chest_open_events%ROWTYPE;
  v_state jsonb;
  v_chests jsonb;
  v_inventory jsonb;
  v_owned jsonb;
  v_equipped_ids jsonb;
  v_bag_count integer;
  v_level integer;
  v_revision bigint;
  v_results jsonb := '[]'::jsonb;
  v_chest jsonb;
  v_chest_id text;
  v_is_boss boolean;
  v_opened_tutorial boolean := false;
  v_weights numeric[];
  v_rarities text[] := ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial'];
  v_rarity_mult numeric[] := ARRAY[0.3,0.7,1.4,2.8,4.6,6.5,9,13,18];
  v_total numeric;
  v_higher_total numeric;
  v_transferred numeric;
  v_roll numeric;
  v_cursor numeric;
  v_rarity_index integer;
  v_floor_index integer;
  v_rarity text;
  v_catalog_index integer;
  v_base_item_id text;
  v_slot text;
  v_item_level integer;
  v_stat_count integer;
  v_stat_pool text[];
  v_stat_key text;
  v_stat_choice integer;
  v_stat_min numeric;
  v_stat_max numeric;
  v_stat_value numeric;
  v_is_percent boolean;
  v_stats jsonb;
  v_power numeric;
  v_power_weight numeric;
  v_item_id uuid;
  v_item jsonb;
  v_divine_count integer;
  v_divine_max integer;
  v_celestial_count integer;
  v_celestial_max integer;
  v_session_opened integer;
  i integer;
  j integer;
BEGIN
  IF p_count NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'invalid_chest_count'; END IF;

  SELECT * INTO v_existing FROM public.chest_open_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.chest_count <> p_count THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  PERFORM 1 FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  SELECT * INTO v_existing FROM public.chest_open_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.chest_count <> p_count THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' OR jsonb_typeof(v_inventory) <> 'array' OR jsonb_typeof(v_owned) <> 'array' THEN
    RAISE EXCEPTION 'invalid_inventory_state';
  END IF;
  IF jsonb_array_length(v_chests) < p_count THEN RAISE EXCEPTION 'chest_count_exceeded'; END IF;

  SELECT COALESCE(jsonb_agg(equipped_uid), '[]'::jsonb)
  INTO v_equipped_ids
  FROM (
    SELECT equipped.value AS equipped_uid
    FROM jsonb_array_elements(v_owned) AS heroes(hero)
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(heroes.hero->'equipped', '{}'::jsonb)) AS equipped(key, value)
    WHERE equipped.value <> ''
  ) equipped;

  SELECT count(*) INTO v_bag_count
  FROM jsonb_array_elements(v_inventory) AS entries(item)
  WHERE NOT (v_equipped_ids ? COALESCE(entries.item->>'uid', ''));
  IF v_bag_count + p_count > 64 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;

  SELECT existing_count, max_existing INTO v_divine_count, v_divine_max
  FROM public.rarity_supply WHERE rarity = 'divine' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'divine_supply_missing'; END IF;
  SELECT existing_count, max_existing INTO v_celestial_count, v_celestial_max
  FROM public.rarity_supply WHERE rarity = 'celestial' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'celestial_supply_missing'; END IF;

  v_level := GREATEST(1, LEAST(10000, COALESCE((v_state->>'accountLevel')::integer, 1)));

  FOR i IN 1..p_count LOOP
    v_chest := v_chests->0;
    v_chests := v_chests - 0;
    v_chest_id := COALESCE(v_chest->>'id', '');
    IF v_chest_id = '' THEN RAISE EXCEPTION 'invalid_chest'; END IF;
    v_is_boss := COALESCE((v_chest->>'boss')::boolean, false);
    v_opened_tutorial := v_opened_tutorial OR COALESCE((v_chest->>'tutorial')::boolean, false);

    v_weights := CASE
      WHEN v_level < 10 THEN ARRAY[75,20,5,0,0,0,0,0,0]::numeric[]
      WHEN v_level < 20 THEN ARRAY[53,29,14,4,0,0,0,0,0]::numeric[]
      WHEN v_level < 30 THEN ARRAY[39,29,20,9,3,0,0,0,0]::numeric[]
      WHEN v_level < 40 THEN ARRAY[29,25,22,14,7,3,0,0,0]::numeric[]
      WHEN v_level < 55 THEN ARRAY[23,21,22,17,10,5,2,0,0]::numeric[]
      WHEN v_level < 80 THEN ARRAY[17,19,20,18,13,7,3.5,2.5,0]::numeric[]
      ELSE ARRAY[12,15,19,19,15,10,5,3,2]::numeric[]
    END;
    IF v_divine_count >= v_divine_max THEN v_weights[8] := 0; END IF;
    IF v_celestial_count >= v_celestial_max THEN v_weights[9] := 0; END IF;

    IF v_is_boss THEN
      v_floor_index := CASE WHEN v_level >= 10 THEN 4 ELSE 3 END;
      FOR j IN 1..v_floor_index - 1 LOOP v_weights[j] := 0; END LOOP;
      v_transferred := 0;
      FOR j IN 5..9 LOOP
        v_roll := v_weights[j];
        v_weights[j] := v_weights[j] * (ARRAY[0.60,0.35,0.20,0.10,0.05]::numeric[])[j - 4];
        v_transferred := v_transferred + v_roll - v_weights[j];
      END LOOP;
      v_weights[v_floor_index] := v_weights[v_floor_index] + v_transferred;
    ELSE
      v_higher_total := 0;
      FOR j IN 2..9 LOOP v_higher_total := v_higher_total + v_weights[j]; END LOOP;
      v_weights[1] := GREATEST(0, v_weights[1] - 10);
      IF v_higher_total > 0 THEN
        FOR j IN 2..9 LOOP v_weights[j] := v_weights[j] + 10 * v_weights[j] / v_higher_total; END LOOP;
      END IF;
      v_transferred := 0;
      FOR j IN 5..9 LOOP
        v_roll := v_weights[j];
        v_weights[j] := v_weights[j] * (ARRAY[0.60,0.35,0.20,0.10,0.05]::numeric[])[j - 4];
        v_transferred := v_transferred + v_roll - v_weights[j];
      END LOOP;
      v_weights[1] := v_weights[1] + v_transferred;
    END IF;

    v_total := 0;
    FOR j IN 1..9 LOOP v_total := v_total + v_weights[j]; END LOOP;
    IF v_total <= 0 THEN RAISE EXCEPTION 'loot_pool_empty'; END IF;
    v_roll := random() * v_total;
    v_cursor := 0;
    v_rarity_index := 1;
    FOR j IN 1..9 LOOP
      v_cursor := v_cursor + v_weights[j];
      IF v_roll <= v_cursor THEN v_rarity_index := j; EXIT; END IF;
    END LOOP;
    v_rarity := v_rarities[v_rarity_index];

    v_catalog_index := floor(random() * 16)::integer;
    IF v_catalog_index < 5 THEN
      v_slot := 'class_weapon';
      v_base_item_id := 'weapon-' || (ARRAY['mage','assassin','warrior','druid','crossbowman'])[v_catalog_index + 1] || '-' || v_rarity;
    ELSIF v_catalog_index < 10 THEN
      v_slot := 'offhand';
      v_base_item_id := 'offhand-' || (ARRAY['mage','assassin','warrior','druid','crossbowman'])[v_catalog_index - 4] || '-' || v_rarity;
    ELSE
      v_slot := (ARRAY['helmet','chest','gloves','boots','amulet','ring'])[v_catalog_index - 9];
      v_base_item_id := (ARRAY['helmet','armor','gloves','boots','amulet','ring'])[v_catalog_index - 9] || '-' || v_rarity;
    END IF;
    v_item_level := GREATEST(1, v_level + floor(random() * 5)::integer - 2);
    v_stat_count := (ARRAY[1,1,2,2,3,3,4,4,5])[v_rarity_index];
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
    v_stats := '[]'::jsonb;
    v_power := 0;
    FOR j IN 1..v_stat_count LOOP
      v_stat_choice := 1 + floor(random() * array_length(v_stat_pool, 1))::integer;
      v_stat_key := v_stat_pool[v_stat_choice];
      v_stat_pool := array_remove(v_stat_pool, v_stat_key);
      SELECT stat_min, stat_max INTO v_stat_min, v_stat_max FROM (VALUES
        ('hp',8::numeric,20::numeric), ('atk',2,5), ('def',1,4), ('atkSpeed',3,8),
        ('critChance',0.005,0.015), ('critDamage',0.02,0.06), ('goldBonus',0.01,0.03),
        ('xpBonus',0.01,0.03), ('dodge',0.005,0.015)
      ) AS ranges(stat_key, stat_min, stat_max) WHERE stat_key = v_stat_key;
      v_stat_value := (v_stat_min + random() * (v_stat_max - v_stat_min))
        * v_rarity_mult[v_rarity_index] * (1 + (v_item_level - 1) * 0.03);
      v_is_percent := v_stat_key IN ('critChance','critDamage','goldBonus','xpBonus','dodge');
      v_stat_value := CASE WHEN v_is_percent THEN round(v_stat_value, 3) ELSE round(v_stat_value) END;
      v_stats := v_stats || jsonb_build_array(jsonb_build_object(
        'key', v_stat_key, 'value', v_stat_value, 'isPercent', v_is_percent
      ));
      v_power_weight := CASE v_stat_key
        WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN 0.5
        WHEN 'hp' THEN 0.15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100 WHEN 'dodge' THEN 150
        ELSE 1 END;
      v_power := v_power + v_stat_value * v_power_weight;
    END LOOP;
    v_power := round(v_power);
    v_item_id := gen_random_uuid();
    v_item := jsonb_build_object(
      'uid', v_item_id::text,
      'itemId', v_base_item_id,
      'level', v_item_level,
      'stats', v_stats,
      'power', v_power,
      'serverOwned', true,
      'enchantLevel', 0,
      'enchantStatsVersion', 2,
      'rerollCount', 0,
      'locked', v_rarity IN ('divine','celestial')
    );
    INSERT INTO public.player_items (
      id, player_id, base_item_id, slot, rarity, item_level, stats, power, locked,
      reroll_count, enchant_stats_version, source_kind, source_chest_id
    ) VALUES (
      v_item_id, p_player_id, v_base_item_id, v_slot, v_rarity, v_item_level, v_stats, v_power,
      v_rarity IN ('divine','celestial'), 0, 2, CASE WHEN v_is_boss THEN 'boss_chest' ELSE 'standard_chest' END, v_chest_id
    );
    IF v_rarity = 'divine' THEN v_divine_count := v_divine_count + 1; END IF;
    IF v_rarity = 'celestial' THEN v_celestial_count := v_celestial_count + 1; END IF;
    v_inventory := v_inventory || jsonb_build_array(v_item);
    v_results := v_results || jsonb_build_array(v_item);
  END LOOP;

  UPDATE public.rarity_supply SET existing_count = v_divine_count, updated_at = now() WHERE rarity = 'divine';
  UPDATE public.rarity_supply SET existing_count = v_celestial_count, updated_at = now() WHERE rarity = 'celestial';
  v_state := jsonb_set(v_state, '{chests}', v_chests, true);
  v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
  v_session_opened := COALESCE((v_state#>>'{session,chestsOpened}')::integer, 0) + p_count;
  v_state := jsonb_set(v_state, '{session,chestsOpened}', to_jsonb(v_session_opened), true);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.advance_chest_quests(v_state->'dailyQuests', p_count, false), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.advance_chest_quests(v_state->'milestoneQuests', p_count, true), true);
  IF v_opened_tutorial THEN v_state := jsonb_set(v_state, '{tutorial,chestCompleted}', 'true'::jsonb, true); END IF;

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id
  RETURNING revision INTO v_revision;

  v_item := jsonb_build_object(
    'player_id', p_player_id,
    'items', v_results,
    'chest_count', p_count,
    'revision', v_revision
  );
  INSERT INTO public.chest_open_events (idempotency_key, player_id, chest_count, result)
  VALUES (p_idempotency_key, p_player_id, p_count, v_item);
  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.advance_chest_quests(jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_chest_open(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_chest_open(uuid, uuid, integer) TO service_role;
