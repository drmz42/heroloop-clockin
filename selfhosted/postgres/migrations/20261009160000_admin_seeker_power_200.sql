\set ON_ERROR_STOP on

-- Seeker-only read helper parity with the accepted level-200 progression.
-- No gameplay/reward formula, player row, signature or privilege changes.
-- This migration is prepared source; Production installation requires separate approval.
-- Preserve historical 1-99 values and extend hero mastery/item scaling linearly.
CREATE OR REPLACE FUNCTION admin.game_registry_hero_power(p_hero_id text, p_level numeric, p_stars numeric, p_items jsonb)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_id text := coalesce(p_hero_id, '');
  v_split integer;
  v_class text;
  v_rarity text;
  v_tier integer;
  v_scale double precision;
  -- archetype: hp, atk, def, speed, growth x3, crit, crit damage, dps, hp mult, regen, dodge, attack speed, caps x5
  a double precision[];
  v_level integer := least(200, greatest(1, floor(coalesce(p_level, 0))::integer));
  v_stars integer := least(20, greatest(0, floor(coalesce(p_stars, 0))::integer));
  v_items jsonb := CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END;
  v_count integer;
  v_set double precision := 0;
  v_resonance double precision := 0;
  v_item jsonb;
  v_stat jsonb;
  v_key text;
  v_version numeric;
  v_v3 boolean;
  v_enchant integer;
  v_base_main double precision;
  v_base_other double precision;
  v_extra double precision;
  v_multiplier double precision;
  v_value double precision;
  v_percent boolean;
  v_effective double precision;
  v_slot text;
  v_implicit_scale double precision;
  v_item_level integer;
  i_hp double precision := 0;
  i_atk double precision := 0;
  i_def double precision := 0;
  i_speed double precision := 0;
  i_crit double precision := 0;
  i_crit_damage double precision := 0;
  i_dodge double precision := 0;
  v_star_scale double precision;
  v_mastery double precision;
  v_growth double precision;
  v_hp double precision;
  v_atk double precision;
  v_def double precision;
  v_speed double precision;
  v_attack_speed double precision;
  v_interval double precision;
  v_crit double precision;
  v_crit_damage double precision;
  v_dodge double precision;
  v_dps double precision;
  v_mitigation double precision;
BEGIN
  v_id := CASE v_id
    WHEN 'ironfoot' THEN 'knight-common' WHEN 'greenscout' THEN 'archer-common' WHEN 'cutpurse' THEN 'assassin-common'
    WHEN 'acolyte' THEN 'shepherd-common' WHEN 'shrubmage' THEN 'druid-common' WHEN 'dawnknight' THEN 'knight-uncommon'
    WHEN 'thornranger' THEN 'archer-uncommon' WHEN 'moonpriest' THEN 'shepherd-uncommon' WHEN 'grovekeeper' THEN 'druid-uncommon'
    WHEN 'stoneguard' THEN 'knight-rare' WHEN 'stormsniper' THEN 'archer-rare' WHEN 'duskblade' THEN 'assassin-rare'
    WHEN 'irondruid' THEN 'druid-rare' WHEN 'voidknight' THEN 'knight-epic' WHEN 'starfall' THEN 'archer-epic'
    WHEN 'deathwhisper' THEN 'assassin-epic' WHEN 'solarsage' THEN 'shepherd-epic' WHEN 'stormdruid' THEN 'druid-epic'
    WHEN 'sunpaladin' THEN 'knight-legendary' WHEN 'eternalbow' THEN 'archer-legendary' WHEN 'soulreaper' THEN 'assassin-legendary'
    WHEN 'divinehealer' THEN 'shepherd-legendary' WHEN 'worldtree' THEN 'druid-legendary' WHEN 'worldender' THEN 'knight-mythic'
    WHEN 'cosmosarcher' THEN 'archer-mythic' WHEN 'voidstalker' THEN 'assassin-mythic' WHEN 'ancientknight' THEN 'knight-mythic'
    WHEN 'relicdruid' THEN 'druid-mythic' WHEN 'cursedknight' THEN 'knight-mythic' WHEN 'cursedarcher' THEN 'archer-mythic'
    WHEN 'cosmicmage' THEN 'shepherd-cosmic' WHEN 'divine' THEN 'shepherd-divine'
    ELSE v_id END;
  v_split := length(v_id) - position('-' IN reverse(v_id));
  IF position('-' IN v_id) = 0 THEN RETURN NULL; END IF;
  v_class := left(v_id, v_split);
  v_rarity := substr(v_id, v_split + 2);
  v_tier := array_position(ARRAY['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'], v_rarity);
  a := CASE v_class
    WHEN 'shepherd' THEN ARRAY[340, 86, 12, 104, .007, .0115, .0035, .12, 1.85, 1.1, 1, 0, 0, 0, .4, .15, .5, 2.3, .2]
    WHEN 'assassin' THEN ARRAY[310, 78, 10, 130, .0065, .01, .003, .23, 2, 1, 1, 0, .05, 0, .4, .3, .6, 2.5, .25]
    WHEN 'knight' THEN ARRAY[500, 56, 28, 92, .012, .0055, .009, .08, 1.6, 1, 1.15, 0, 0, 0, .6, .1, .45, 2, .2]
    WHEN 'druid' THEN ARRAY[450, 60, 20, 100, .0105, .0065, .0065, .1, 1.7, 1, 1.1, .004, 0, 0, .5, .15, .45, 2.1, .2]
    WHEN 'archer' THEN ARRAY[360, 70, 14, 124, .008, .009, .0045, .15, 2.15, 1, 1, 0, 0, .08, .45, .2, .55, 2.7, .25]
  END::double precision[];
  IF a IS NULL OR v_tier IS NULL THEN RETURN NULL; END IF;
  v_tier := v_tier - 1;
  v_scale := (ARRAY[1, 1.441163, 2.147372, 3.084756, 4.435796, 6.370091, 9.143236, 13.119459, 18.814853]::double precision[])[v_tier + 1];

  -- Set Bonus needs all eight slots in one rarity; Resonance follows the lowest Enchant of a full set.
  v_count := jsonb_array_length(v_items);
  IF v_count = 8 THEN
    IF (SELECT count(DISTINCT coalesce(e->>'rarity', '')) = 1 FROM jsonb_array_elements(v_items) e) THEN
      v_set := coalesce((jsonb_build_object(
        'common', 5, 'uncommon', 10, 'rare', 15, 'epic', 20, 'legendary', 30, 'mythic', 40, 'relic', 40,
        'cosmic', 50, 'divine', 60, 'celestial', 70, 'cursed', 80, 'immortal', 90, 'god', 100
      )->>(v_items->0->>'rarity'))::double precision, 0) / 100;
    END IF;
    v_resonance := (ARRAY[0, 1, 2, 4, 7, 11, 16, 22, 30, 39, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]::double precision[])[
      1 + (SELECT min(least(20, greatest(0, CASE WHEN jsonb_typeof(e->'enchant_level') = 'number' THEN floor((e->>'enchant_level')::numeric)::integer ELSE 0 END)))
           FROM jsonb_array_elements(v_items) e)
    ] / 100;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_version := CASE WHEN jsonb_typeof(v_item->'enchant_stats_version') = 'number' THEN (v_item->>'enchant_stats_version')::numeric END;
    v_v3 := v_version IS NOT DISTINCT FROM 3;
    v_enchant := least(20, greatest(0, CASE WHEN jsonb_typeof(v_item->'enchant_level') = 'number' THEN floor((v_item->>'enchant_level')::numeric)::integer ELSE 0 END));
    -- Enchant multiplier per stat family: version 4 is Balance v6 (+11% a level),
    -- version 3 gave 10% to hp/atk/def and 5% to the rest, older items 10% to all.
    v_base_main := CASE WHEN v_version IS NOT DISTINCT FROM 4 THEN 1::double precision + v_enchant * 0.11::double precision ELSE 1::double precision + v_enchant * 0.1::double precision END;
    v_base_other := CASE WHEN v_version IS NOT DISTINCT FROM 4 THEN v_base_main
                         WHEN v_v3 THEN 1::double precision + v_enchant * 0.05::double precision ELSE v_base_main END;
    v_extra := CASE WHEN v_v3 THEN 0 ELSE v_resonance END;

    FOR v_stat IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_item->'stats') = 'array' THEN v_item->'stats' ELSE '[]'::jsonb END) LOOP
      v_key := v_stat->>'key';
      CONTINUE WHEN v_key IS NULL OR v_key NOT IN ('hp', 'atk', 'def', 'atkSpeed', 'critChance', 'critDamage', 'dodge');
      CONTINUE WHEN jsonb_typeof(v_stat->'value') IS DISTINCT FROM 'number';
      v_value := least(1000000000::double precision, greatest(-1000000000::double precision, (v_stat->>'value')::double precision));
      v_percent := v_stat->'isPercent' = 'true'::jsonb;
      v_multiplier := (CASE WHEN v_key IN ('hp', 'atk', 'def') THEN v_base_main ELSE v_base_other END) + v_set + v_extra;
      v_effective := CASE WHEN v_percent THEN floor(v_value * v_multiplier * 1000 + 0.5) / 1000 ELSE floor(v_value * v_multiplier + 0.5) END;
      CASE v_key
        WHEN 'hp' THEN i_hp := i_hp + v_effective;
        WHEN 'atk' THEN i_atk := i_atk + v_effective;
        WHEN 'def' THEN i_def := i_def + v_effective;
        -- Legacy flat Attack Speed rolls are milliseconds against a one-second reference.
        WHEN 'atkSpeed' THEN i_speed := i_speed + v_effective / (CASE WHEN v_percent THEN 1 ELSE 1000 END);
        WHEN 'critChance' THEN i_crit := i_crit + v_effective;
        WHEN 'critDamage' THEN i_crit_damage := i_crit_damage + v_effective;
        ELSE i_dodge := i_dodge + v_effective;
      END CASE;
    END LOOP;

    -- The fixed base stat every item carries for the slot it is worn in.
    v_slot := coalesce(v_item->>'slot', '');
    v_slot := CASE v_slot WHEN 'weapon' THEN 'class_weapon' WHEN 'armor' THEN 'chest' WHEN 'ring1' THEN 'ring' WHEN 'ring2' THEN 'ring' ELSE v_slot END;
    v_implicit_scale := (jsonb_build_object(
      'common', 1, 'uncommon', 1.61, 'rare', 2.35, 'epic', 3.54, 'legendary', 5.15, 'mythic', 7.68, 'relic', 7.68,
      'cosmic', 11.4, 'divine', 17.1, 'celestial', 25.8, 'cursed', 25.8, 'immortal', 25.8, 'god', 25.8
    )->>coalesce(v_item->>'rarity', ''))::double precision;
    CONTINUE WHEN v_implicit_scale IS NULL;
    v_item_level := least(200, greatest(1, CASE WHEN jsonb_typeof(v_item->'item_level') = 'number' THEN floor((v_item->>'item_level')::numeric)::integer ELSE 0 END));
    v_implicit_scale := v_implicit_scale * ((1::double precision + 0.008::double precision * (least(99, v_item_level) - 1)) * power(1::double precision + 0.014::double precision, least(99, v_item_level) - 1) * (1 + greatest(0, v_item_level - 99) * 0.009::double precision));
    IF v_slot IN ('class_weapon', 'gloves', 'ring', 'amulet') THEN
      i_atk := i_atk + floor(1::double precision * 1.661::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
    ELSIF v_slot IN ('helmet', 'boots', 'offhand') THEN
      i_hp := i_hp + floor(1::double precision * 53.9::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
    ELSIF v_slot = 'chest' THEN
      i_hp := i_hp + floor(0.5::double precision * 53.9::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
      i_def := i_def + floor(0.5::double precision * 9.5::double precision * v_implicit_scale * (v_base_main + v_set + v_extra) + 0.5);
    END IF;
  END LOOP;

  v_star_scale := power(1::double precision + 0.06::double precision, v_stars);
  v_mastery := power(1::double precision + 0.014::double precision, least(99, v_level) - 1)
    * (1 + greatest(0, v_level - 99) * 0.007::double precision);
  v_growth := 1::double precision + v_tier * 0.02::double precision;
  v_hp := floor((a[1] * v_scale * 0.2::double precision * (1 + a[5] * v_growth * (v_level - 1)) * v_star_scale * v_mastery + i_hp) * a[11] + 0.5);
  v_atk := floor(a[2] * v_scale * 0.2::double precision * (1 + a[6] * v_growth * (v_level - 1)) * v_star_scale * v_mastery + i_atk + 0.5);
  v_def := floor(a[3] * v_scale * 0.2::double precision * (1 + a[7] * v_growth * (v_level - 1)) * v_star_scale * v_mastery + i_def + 0.5);
  v_speed := a[4] * (1 + v_tier * 0.01::double precision) + v_stars * 0.1::double precision;
  v_attack_speed := least(a[14] + i_speed, a[19]);
  v_interval := greatest(600::double precision, (1540 - least(v_speed * 2.2::double precision, 700::double precision)) / (1 + v_attack_speed));
  v_crit := least(a[8] + i_crit, a[17]);
  v_crit_damage := least(a[9] + i_crit_damage, a[18]);
  v_dodge := least(a[13] + i_dodge, a[16]);
  v_dps := v_atk * (1000 / v_interval) * (1 + v_crit * (v_crit_damage - 1)) * a[10];
  v_mitigation := least(a[15], v_def / (v_def + 200));
  RETURN 4 * v_dps + 0.08::double precision * (v_hp / (1 - v_mitigation) / (1 - v_dodge)) + 1.5::double precision * (v_hp * a[12]);
END
$function$;
