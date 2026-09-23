-- Item-roll v5 primitives — GENERATED FILE. Do not edit by hand.
-- Regenerate: node scripts/generate-item-roll-runtime.mjs
-- Runtime stamp: item-roll-v5@sha256:c885bb3ce3920dc9e47bfd9e315ef7b7eb47b6bc44196e0f8047a09e5ec4e363
-- Sources:
--   config/balance/hero-power-model.v1.json sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc
--   config/balance/balance-v4.v1.json sha256:f2e59620f1501eacb5813107d0f1152c873888cc3bf826f77974b064792ba07d
--   config/economy/enchant-v4.v1.json sha256:4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359
--
-- Option-A base rolls (founder-approved normalized equipment), six approved
-- Gold/XP slots (helmet, chest, gloves, boots, ring, amulet) and the existing
-- Balance-v4 Enchant curve through +20 (max 4.50x).
-- ADDITIVE ONLY: defines primitives and patches/calls no chest, store, reroll or
-- enchant flow. Existing v2/v3/v4 items and their versions remain untouched.

CREATE OR REPLACE FUNCTION public.item_roll_v5_enchant_multiplier(p_enchant integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT 1
    + GREATEST(0, LEAST(5, p_enchant) - 0) * 0.1
    + GREATEST(0, LEAST(10, p_enchant) - 5) * 0.15
    + GREATEST(0, LEAST(15, p_enchant) - 10) * 0.2
    + GREATEST(0, LEAST(20, p_enchant) - 15) * 0.25
$$;

CREATE OR REPLACE FUNCTION public.roll_item_stats_v5(
  p_slot text,
  p_rarity text,
  p_item_level integer,
  p_base_item_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
DECLARE
  v_lines integer;
  v_rarity_mult numeric;
  v_pool text[];
  v_class text;
  v_key text;
  v_choice integer;
  v_curve text;
  v_min numeric;
  v_max numeric;
  v_rarity_factor numeric;
  v_level_mult numeric;
  v_value numeric;
  v_percent boolean;
  v_stats jsonb := '[]'::jsonb;
  v_remaining integer;
  i integer;
BEGIN
  v_lines := CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 WHEN 'epic' THEN 2 WHEN 'legendary' THEN 3 WHEN 'mythic' THEN 3 WHEN 'cosmic' THEN 4 WHEN 'divine' THEN 4 WHEN 'celestial' THEN 5 WHEN 'cursed' THEN 5 WHEN 'immortal' THEN 6 WHEN 'god' THEN 6 ELSE NULL END;
  v_rarity_mult := CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1.15 WHEN 'rare' THEN 1.35 WHEN 'epic' THEN 1.6 WHEN 'legendary' THEN 1.9 WHEN 'mythic' THEN 2.25 WHEN 'cosmic' THEN 2.65 WHEN 'divine' THEN 3.1 WHEN 'celestial' THEN 3.6 WHEN 'cursed' THEN 4.1 WHEN 'immortal' THEN 4.7 WHEN 'god' THEN 5.4 ELSE NULL END;
  IF p_slot IS NULL OR p_rarity IS NULL OR p_item_level IS NULL OR p_base_item_id IS NULL
     OR v_lines IS NULL OR v_rarity_mult IS NULL OR p_item_level NOT BETWEEN 1 AND 99 THEN
    RAISE EXCEPTION 'invalid_item_roll_v5';
  END IF;
  v_class := split_part(p_base_item_id, '-', 2);
  v_pool := CASE p_slot
    WHEN 'class_weapon' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
    WHEN 'helmet' THEN ARRAY['hp','def','dodge','critChance','critDamage','goldBonus','xpBonus']
    WHEN 'chest' THEN ARRAY['hp','def','dodge','atk','critDamage','goldBonus','xpBonus']
    WHEN 'gloves' THEN ARRAY['atk','atkSpeed','critChance','critDamage','def','goldBonus','xpBonus']
    WHEN 'boots' THEN ARRAY['hp','def','dodge','atkSpeed','critChance','goldBonus','xpBonus']
    WHEN 'ring' THEN ARRAY['atk','critChance','critDamage','dodge','goldBonus','xpBonus','hp']
    WHEN 'amulet' THEN ARRAY['hp','def','critDamage','dodge','goldBonus','xpBonus','critChance']
    WHEN 'offhand' THEN CASE v_class
      WHEN 'warrior' THEN ARRAY['hp','def','dodge','atk','critChance']
      WHEN 'mage' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
      WHEN 'assassin' THEN ARRAY['atk','atkSpeed','critChance','critDamage','dodge']
      WHEN 'druid' THEN ARRAY['hp','def','atk','critChance','critDamage']
      WHEN 'crossbowman' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
      ELSE NULL END
    ELSE NULL END;
  IF v_pool IS NULL THEN RAISE EXCEPTION 'invalid_item_roll_v5'; END IF;

  v_remaining := LEAST(v_lines, array_length(v_pool, 1));
  FOR i IN 1..v_remaining LOOP
    v_choice := 1 + floor(random() * array_length(v_pool, 1))::integer;
    v_key := v_pool[v_choice];
    v_pool := array_remove(v_pool, v_key);
    SELECT stat_min, stat_max, stat_curve INTO v_min, v_max, v_curve FROM (VALUES
      ('hp', 3.658817373::numeric, 4.573521716::numeric, 'main'),
      ('atk', 0.914704343::numeric, 1.143380429::numeric, 'main'),
      ('def', 0.335391593::numeric, 0.419239491::numeric, 'main'),
      ('dodge', 0.001553236::numeric, 0.001941545::numeric, 'slow'),
      ('critChance', 0.003106472::numeric, 0.00388309::numeric, 'slow'),
      ('critDamage', 0.004400835::numeric, 0.005501044::numeric, 'slow'),
      ('atkSpeed', 0.003235908::numeric, 0.004044885::numeric, 'slow'),
      ('goldBonus', 0.005177453::numeric, 0.006471816::numeric, 'economy'),
      ('xpBonus', 0.005177453::numeric, 0.006471816::numeric, 'economy')
    ) AS ranges(stat_key, stat_min, stat_max, stat_curve) WHERE stat_key = v_key;
    v_percent := v_key NOT IN ('hp', 'atk', 'def');
    v_level_mult := 1 + (p_item_level - 1)
      * CASE WHEN v_curve = 'main' THEN 0.015 ELSE 0.005 END
      + 0.2 * floor((p_item_level - 1) / 15);
    v_rarity_factor := CASE WHEN v_curve = 'main' THEN v_rarity_mult ELSE sqrt(v_rarity_mult) END;
    v_value := (v_min + random() * (v_max - v_min)) * v_rarity_factor * v_level_mult;
    v_value := round(v_value, 6);
    v_stats := v_stats || jsonb_build_array(jsonb_build_object('key', v_key, 'value', v_value, 'isPercent', v_percent));
  END LOOP;
  RETURN v_stats;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_item_power_v5(p_stats jsonb, p_enchant integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT round(COALESCE(sum(
    (stat->>'value')::numeric * CASE stat->>'key'
      WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN 0.5
      WHEN 'hp' THEN 0.15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100
      WHEN 'dodge' THEN 150 ELSE 1 END
    * public.item_roll_v5_enchant_multiplier(LEAST(20, GREATEST(0, p_enchant)))
  ), 0))::bigint
  FROM jsonb_array_elements(p_stats) stat
$$;

REVOKE ALL ON FUNCTION public.item_roll_v5_enchant_multiplier(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.roll_item_stats_v5(text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.calculate_item_power_v5(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.item_roll_v5_enchant_multiplier(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.roll_item_stats_v5(text, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.calculate_item_power_v5(jsonb, integer) TO service_role;
