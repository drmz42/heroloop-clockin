-- Balance v6 Staging candidate (docs/game/balance-v6-proposal.md, HL-TASK-20260929004344-AD72C4).
-- Hero Stars +6% each, Hero Level mastery on base stats only, a slot base stat on every item,
-- linear Enchant +11% per level, v6 Location bands. Existing encounter snapshots, stored item
-- rows and recorded events stay immutable; only new encounters use the new formulas.
BEGIN;

CREATE OR REPLACE FUNCTION public.dungeon_star_multiplier(p_stars integer)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT power(1.06::numeric, LEAST(20, GREATEST(0, p_stars)))
$$;

CREATE OR REPLACE FUNCTION public.hero_level_mastery(p_level integer)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT power(1.014::numeric, LEAST(99, GREATEST(1, p_level)) - 1)
$$;
REVOKE ALL ON FUNCTION public.hero_level_mastery(integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enchant_v6_multiplier(p_level integer)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT 1 + LEAST(20, GREATEST(0, COALESCE(p_level, 0))) * 0.11
$$;
REVOKE ALL ON FUNCTION public.enchant_v6_multiplier(integer) FROM PUBLIC, anon, authenticated;

-- Unrounded slot base stat of one item before Enchant, Set Bonus and Resonance
-- (mirrors v6ItemImplicit in managed/functions/player-sync/balance-v6.mjs).
CREATE OR REPLACE FUNCTION public.item_v6_implicit(p_slot text, p_rarity text, p_item_level integer, p_stat text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  WITH slot AS (
    SELECT CASE p_slot WHEN 'weapon' THEN 'class_weapon' WHEN 'armor' THEN 'chest'
      WHEN 'ring1' THEN 'ring' WHEN 'ring2' THEN 'ring' ELSE p_slot END AS id
  ), share AS (
    SELECT CASE
      WHEN p_stat = 'atk' AND slot.id IN ('class_weapon', 'gloves', 'ring', 'amulet') THEN 1
      WHEN p_stat = 'hp' AND slot.id IN ('helmet', 'boots', 'offhand') THEN 1
      WHEN p_stat IN ('hp', 'def') AND slot.id = 'chest' THEN .5
      ELSE 0 END::numeric AS value
    FROM slot
  ), level AS (
    SELECT LEAST(99, GREATEST(1, COALESCE(p_item_level, 1))) AS value
  )
  SELECT share.value
    * CASE p_stat WHEN 'atk' THEN 1.661 WHEN 'hp' THEN 53.9 WHEN 'def' THEN 9.5 ELSE 0 END
    * CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1.61 WHEN 'rare' THEN 2.35 WHEN 'epic' THEN 3.54
        WHEN 'legendary' THEN 5.15 WHEN 'mythic' THEN 7.68 WHEN 'relic' THEN 7.68 WHEN 'cosmic' THEN 11.4
        WHEN 'divine' THEN 17.1 WHEN 'celestial' THEN 25.8 WHEN 'cursed' THEN 25.8 WHEN 'immortal' THEN 25.8
        WHEN 'god' THEN 25.8 ELSE 0 END
    * (1 + 0.008 * (level.value - 1)) * power(1.014::numeric, level.value - 1)
  FROM share, level
$$;
REVOKE ALL ON FUNCTION public.item_v6_implicit(text, text, integer, text) FROM PUBLIC, anon, authenticated;

-- Highest Location an Account Level unlocks under the v6 bands.
CREATE OR REPLACE FUNCTION public.balance_v6_location_cap(p_account_level integer)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT count(*)::integer
  FROM unnest(ARRAY[1,5,10,16,23,28,33,38,43,48,53,58,63,68,73,78,83,88,92,96]) unlock_level
  WHERE unlock_level <= GREATEST(1, COALESCE(p_account_level, 1))
$$;
REVOKE ALL ON FUNCTION public.balance_v6_location_cap(integer) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- Dungeon and Boss roster snapshots: v6 Enchant, item base stat, mastery on base stats only.
  v_def := pg_get_functiondef('public.dungeon_roster_snapshot(uuid,jsonb)'::regprocedure);
  v_new := replace(v_def, 'public.enchant_v4_multiplier(v_item.enchant_level)', 'public.enchant_v6_multiplier(v_item.enchant_level)');
  v_new := replace(v_new,
    $find$      v_equipment := v_equipment || jsonb_build_array(jsonb_build_object(
        'slot', v_equipment_entry.slot,$find$,
    $find$      v_stat_value := public.item_v6_implicit(v_equipment_entry.slot, v_item.rarity, v_item.item_level, 'hp');
      v_raw_item_hp := v_raw_item_hp + v_stat_value; v_item_hp := v_item_hp + v_stat_value * v_enchant_multiplier;
      v_stat_value := public.item_v6_implicit(v_equipment_entry.slot, v_item.rarity, v_item.item_level, 'atk');
      v_raw_item_atk := v_raw_item_atk + v_stat_value; v_item_atk := v_item_atk + v_stat_value * v_enchant_multiplier;
      v_stat_value := public.item_v6_implicit(v_equipment_entry.slot, v_item.rarity, v_item.item_level, 'def');
      v_raw_item_def := v_raw_item_def + v_stat_value; v_item_def := v_item_def + v_stat_value * v_enchant_multiplier;

      v_equipment := v_equipment || jsonb_build_array(jsonb_build_object(
        'slot', v_equipment_entry.slot,$find$);
  v_new := replace(v_new, '* v_star_scale + v_item_hp)', '* v_star_scale * public.hero_level_mastery(v_level) + v_item_hp)');
  v_new := replace(v_new, '* v_star_scale + v_item_atk)', '* v_star_scale * public.hero_level_mastery(v_level) + v_item_atk)');
  v_new := replace(v_new, '* v_star_scale + v_item_def)', '* v_star_scale * public.hero_level_mastery(v_level) + v_item_def)');
  v_new := replace(v_new, $find$    v_hp := round(v_hp * public.hero_level_mastery(v_level));
    v_atk := round(v_atk * public.hero_level_mastery(v_level));
    v_def := round(v_def * public.hero_level_mastery(v_level));
$find$, '');
  IF position('enchant_v4_multiplier' IN v_new) > 0 OR position('item_v6_implicit' IN v_new) = 0
    OR (length(v_new) - length(replace(v_new, 'public.hero_level_mastery(v_level)', ''))) / length('public.hero_level_mastery(v_level)') <> 3
    OR position('round(v_hp * public.hero_level_mastery' IN v_new) > 0 THEN
    RAISE EXCEPTION 'balance_v6_dungeon_snapshot_patch_failed';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.dungeon_equipment_combat_stat(jsonb,text)'::regprocedure);
  v_new := replace(v_def, 'public.enchant_v4_multiplier(', 'public.enchant_v6_multiplier(');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v6_dungeon_equipment_stat_patch_failed'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.dungeon_start(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def, '''balance-v5-progression-2026.09.28-v1''', '''balance-v6-2026.09.29-v1''');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v6_dungeon_version_patch_failed'; END IF;
  EXECUTE v_new;

  -- Normal combat: v6 Location gate and Item Level for the item base stat.
  v_def := pg_get_functiondef('public.normal_combat_prepare(uuid,uuid,integer)'::regprocedure);
  v_new := regexp_replace(v_def, 'v_location_cap := CASE.*?ELSE 1 END;',
    'v_location_cap := public.balance_v6_location_cap(COALESCE((v_save.state->>''accountLevel'')::integer, 1));');
  v_new := replace(v_new, $find$'id', id, 'base_item_id', base_item_id, 'slot', slot, 'rarity', rarity,$find$,
    $find$'id', id, 'base_item_id', base_item_id, 'slot', slot, 'rarity', rarity, 'item_level', item_level,$find$);
  IF position('balance_v6_location_cap' IN v_new) = 0 OR position('''item_level'', item_level' IN v_new) = 0
    OR position('>= 70 THEN' IN v_new) > 0 THEN
    RAISE EXCEPTION 'balance_v6_normal_combat_prepare_patch_failed';
  END IF;
  EXECUTE v_new;

  -- Legacy periodic settlement keeps its ten-Location ceiling under the v6 bands.
  v_def := pg_get_functiondef('public.settle_periodic_progression_legacy(uuid,timestamp with time zone)'::regprocedure);
  v_new := regexp_replace(v_def, 'v_level_location_cap := CASE.*?ELSE 1\s+END;',
    'v_level_location_cap := LEAST(10, public.balance_v6_location_cap(COALESCE((v_state->>''accountLevel'')::integer, 1)));');
  IF position('balance_v6_location_cap' IN v_new) = 0 OR position('>= 70 THEN' IN v_new) > 0 THEN
    RAISE EXCEPTION 'balance_v6_periodic_location_patch_failed';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_training_state_at(jsonb,timestamp with time zone,integer)'::regprocedure);
  v_new := replace(v_def, 'ARRAY[1,5,10,16,23,31,40,50,60,70,80,82,84,86,88,90,92,94,96,98]',
    'ARRAY[1,5,10,16,23,28,33,38,43,48,53,58,63,68,73,78,83,88,92,96]');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v6_training_location_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.normal_combat_balance_version_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_requested text := nullif(current_setting('heroloop.normal_combat_balance_version', true), '');
BEGIN
  v_requested := coalesce(v_requested, 'balance-v6-2026.09.29-v1-combat-effects-v1');
  IF v_requested NOT IN (
    'balance-v4-2026.09.01-v6-combat-effects-v1',
    'balance-v4-2026.09.06-v7-combat-effects-v2-candidate',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v1',
    'balance-v5-progression-2026.09.28-v1-combat-effects-v2',
    'balance-v6-2026.09.29-v1-combat-effects-v1',
    'balance-v6-2026.09.29-v1-combat-effects-v2'
  ) THEN
    RAISE EXCEPTION 'normal_combat_balance_version_invalid';
  END IF;
  NEW.balance_version := v_requested;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.normal_combat_balance_version_gate() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('telemetry.stamp_economy_settlement()'::regprocedure);
  v_new := replace(v_def,
    $find$    'balance-v5-progression-2026.09.28-v1-combat-effects-v2'
  ) THEN RETURN NEW; END IF;$find$,
    $find$    'balance-v5-progression-2026.09.28-v1-combat-effects-v2',
    'balance-v6-2026.09.29-v1',
    'balance-v6-2026.09.29-v1-combat-effects-v1',
    'balance-v6-2026.09.29-v1-combat-effects-v2'
  ) THEN RETURN NEW; END IF;$find$);
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v6_economy_stamp_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;

ALTER TABLE public.normal_combat_events
  ALTER COLUMN balance_version SET DEFAULT 'balance-v6-2026.09.29-v1';
ALTER TABLE public.boss_encounters
  ALTER COLUMN balance_version SET DEFAULT 'balance-v6-2026.09.29-v1';

COMMIT;
