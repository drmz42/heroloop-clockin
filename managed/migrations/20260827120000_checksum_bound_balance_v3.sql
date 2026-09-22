-- One atomic VPS1 Staging candidate bound to the reviewed model checksum.
-- Existing items and active encounters keep their stored v2 snapshots/versions.

CREATE OR REPLACE FUNCTION public.roll_item_stats_v3(p_slot text, p_rarity text, p_item_level integer, p_base_item_id text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  v_count integer;
  v_pool text[];
  v_allowed text[];
  v_key text;
  v_choice integer;
  v_min numeric;
  v_max numeric;
  v_rarity numeric;
  v_class text;
  v_level numeric;
  v_value numeric;
  v_percent boolean;
  v_stats jsonb := '[]'::jsonb;
  i integer;
BEGIN
  v_count := CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2
    WHEN 'epic' THEN 2 WHEN 'legendary' THEN 3 WHEN 'mythic' THEN 3 WHEN 'relic' THEN 3
    WHEN 'cosmic' THEN 4 WHEN 'divine' THEN 4 WHEN 'celestial' THEN 5 WHEN 'cursed' THEN 5
    WHEN 'immortal' THEN 6 WHEN 'god' THEN 6 ELSE NULL END;
  v_rarity := CASE p_rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 1.15 WHEN 'rare' THEN 1.35
    WHEN 'epic' THEN 1.6 WHEN 'legendary' THEN 1.9 WHEN 'mythic' THEN 2.25 WHEN 'relic' THEN 2.25
    WHEN 'cosmic' THEN 2.65 WHEN 'divine' THEN 3.1 WHEN 'celestial' THEN 3.6 WHEN 'cursed' THEN 4.1
    WHEN 'immortal' THEN 4.7 WHEN 'god' THEN 5.4 ELSE NULL END;
  IF v_count IS NULL OR p_item_level NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid_item_roll'; END IF;
  v_class := split_part(p_base_item_id, '-', 2);
  v_pool := CASE p_slot
    WHEN 'class_weapon' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
    WHEN 'offhand' THEN CASE v_class
      WHEN 'warrior' THEN ARRAY['hp','def','dodge','atk','critChance']
      WHEN 'mage' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp']
      WHEN 'assassin' THEN ARRAY['atk','atkSpeed','critChance','critDamage','dodge']
      WHEN 'druid' THEN ARRAY['hp','def','atk','critChance','critDamage']
      WHEN 'crossbowman' THEN ARRAY['atk','atkSpeed','critChance','critDamage','hp'] ELSE NULL END
    WHEN 'chest' THEN ARRAY['hp','def','dodge','atk','critDamage']
    WHEN 'ring' THEN ARRAY['atk','critChance','critDamage','dodge','goldBonus','xpBonus','hp']
    WHEN 'helmet' THEN ARRAY['hp','def','dodge','critChance','critDamage']
    WHEN 'gloves' THEN ARRAY['atk','atkSpeed','critChance','critDamage','def']
    WHEN 'boots' THEN ARRAY['hp','def','dodge','atkSpeed','critChance']
    WHEN 'amulet' THEN ARRAY['hp','def','critDamage','dodge','goldBonus','xpBonus','critChance']
    ELSE NULL END;
  IF v_pool IS NULL THEN RAISE EXCEPTION 'invalid_item_roll'; END IF;
  v_allowed := v_pool;
  FOR i IN 1..v_count LOOP
    IF COALESCE(array_length(v_pool, 1), 0) = 0 THEN v_pool := v_allowed; END IF;
    v_choice := 1 + floor(random() * array_length(v_pool, 1))::integer;
    v_key := v_pool[v_choice]; v_pool := array_remove(v_pool, v_key);
    SELECT stat_min, stat_max INTO v_min, v_max FROM (VALUES
      ('hp',3.658817373::numeric,4.573521716::numeric),('atk',.914704343,1.143380429),('def',.335391593,.419239491),
      ('dodge',.001553236,.001941545),('critChance',.003106472,.00388309),('critDamage',.004400835,.005501044),
      ('atkSpeed',.003235908,.004044885),('goldBonus',.005177453,.006471816),('xpBonus',.005177453,.006471816)
    ) ranges(stat_key,stat_min,stat_max) WHERE stat_key=v_key;
    v_percent := v_key NOT IN ('hp','atk','def');
    v_level := 1 + (p_item_level - 1) * CASE WHEN v_percent THEN .005 ELSE .015 END
      + .2 * floor((p_item_level - 1) / 15);
    v_value := (v_min + random() * (v_max-v_min)) * CASE WHEN v_percent THEN sqrt(v_rarity) ELSE v_rarity END * v_level;
    v_value := CASE WHEN v_percent THEN round(v_value,6) ELSE round(v_value) END;
    v_stats := v_stats || jsonb_build_array(jsonb_build_object('key',v_key,'value',v_value,'isPercent',v_percent));
  END LOOP;
  RETURN v_stats;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_item_power_v3(p_stats jsonb, p_enchant integer)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT round(COALESCE(sum(
    (stat->>'value')::numeric * CASE stat->>'key'
      WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN .5
      WHEN 'hp' THEN .15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100 WHEN 'dodge' THEN 150 ELSE 1 END
    * (1 + LEAST(10,GREATEST(0,p_enchant)) * CASE WHEN stat->>'key' IN ('hp','atk','def') THEN .1
      WHEN stat->>'key' IN ('goldBonus','xpBonus') THEN .025 ELSE .05 END)
  ),0))::bigint FROM jsonb_array_elements(p_stats) stat
$$;

DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  v_new := regexp_replace(v_def,
    $find$v_stats := '\[\]'::jsonb;.*v_power := round\(v_power\);$find$,
    E'v_stats := public.roll_item_stats_v3(v_slot, v_rarity, v_item_level, v_base_item_id);\n    v_power := public.calculate_item_power_v3(v_stats, 0);', 'ns');
  v_new := replace(replace(v_new, $find$'enchantStatsVersion', 2$find$, $find$'enchantStatsVersion', 3$find$),
    $find$v_rarity IN ('divine','celestial'), 0, 2, CASE$find$, $find$v_rarity IN ('divine','celestial'), 0, 3, CASE$find$);
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v3_chest_patch_failed'; END IF; EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_store_purchase(uuid,uuid,integer,bigint)'::regprocedure);
  v_new := regexp_replace(v_def, E'v_stat_count := .*v_power := round\\(v_power\\);',
    E'v_stats := public.roll_item_stats_v3(v_slot, v_rarity, 1, v_base_item_id);\n  v_power := public.calculate_item_power_v3(v_stats, 0);', 'ns');
  v_new := replace(replace(v_new, $find$'enchantStatsVersion', 2$find$, $find$'enchantStatsVersion', 3$find$),
    $find$v_stats, v_power, false, 0, 2, 'store'$find$, $find$v_stats, v_power, false, 0, 3, 'store'$find$);
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v3_store_patch_failed'; END IF; EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_item_upgrade_v2(uuid,uuid,text,uuid,boolean)'::regprocedure);
  v_new := replace(v_def, 'v_stats := public.roll_item_stats(v_item.slot, v_item.rarity, v_item.item_level);',
    'v_stats := public.roll_item_stats_v3(v_item.slot, v_item.rarity, v_item.item_level, v_item.base_item_id);');
  v_new := replace(v_new, 'v_new_power := public.calculate_item_power(v_stats, v_item.enchant_level);',
    'v_new_power := public.calculate_item_power_v3(v_stats, v_item.enchant_level);');
  v_new := replace(v_new, 'enchant_stats_version = 2', 'enchant_stats_version = 3');
  v_new := replace(v_new, $find$'{enchantStatsVersion}', '2'::jsonb, true);$find$, $find$'{enchantStatsVersion}', '3'::jsonb, true);$find$);
  v_new := replace(v_new, 'v_new_power := public.calculate_item_power(v_item.stats, v_new_enchant);',
    'v_new_power := CASE WHEN v_item.enchant_stats_version = 3 THEN public.calculate_item_power_v3(v_item.stats, v_new_enchant) ELSE public.calculate_item_power(v_item.stats, v_new_enchant) END;');
  v_new := replace(v_new, $find$'{enchantStatsVersion}', '2'::jsonb, true), '{power}'$find$, $find$'{enchantStatsVersion}', to_jsonb(v_item.enchant_stats_version), true), '{power}'$find$);
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v3_upgrade_patch_failed'; END IF; EXECUTE v_new;
END;
$$;

ALTER TABLE public.normal_combat_events DROP CONSTRAINT normal_combat_events_location_check;
ALTER TABLE public.normal_combat_events ADD CONSTRAINT normal_combat_events_location_check CHECK (location BETWEEN 1 AND 20);
ALTER TABLE public.normal_combat_events ADD COLUMN balance_version text;
UPDATE public.normal_combat_events SET balance_version=CASE WHEN outcome IS NULL
  THEN 'hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc'
  ELSE '2026.08.02-v2' END WHERE balance_version IS NULL;
ALTER TABLE public.normal_combat_events ALTER COLUMN balance_version SET DEFAULT 'hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc';
ALTER TABLE public.normal_combat_events ALTER COLUMN balance_version SET NOT NULL;

DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.normal_combat_event_result(public.normal_combat_events,boolean)'::regprocedure);
  v_new := replace(v_def, $find$'seed', p_event.seed,$find$, $find$'seed', p_event.seed, 'balance_version', p_event.balance_version,$find$);
  IF v_new=v_def THEN RAISE EXCEPTION 'balance_v3_normal_result_patch_failed'; END IF; EXECUTE v_new;

  v_def := pg_get_functiondef('public.normal_combat_prepare(uuid,uuid,integer)'::regprocedure);
  v_new := replace(v_def, 'p_location NOT BETWEEN 1 AND 10', 'p_location NOT BETWEEN 1 AND 20');
  v_new := replace(v_new, 'WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 70 THEN 10',
    'WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 98 THEN 20
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 96 THEN 19
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 94 THEN 18
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 92 THEN 17
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 90 THEN 16
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 88 THEN 15
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 86 THEN 14
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 84 THEN 13
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 82 THEN 12
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 80 THEN 11
    WHEN COALESCE((v_save.state->>''accountLevel'')::integer, 1) >= 70 THEN 10');
  v_new := replace(v_new, $find$'stats', stats, 'enchant_level', enchant_level, 'reroll_count', reroll_count$find$,
    $find$'stats', stats, 'enchant_level', enchant_level, 'enchant_stats_version', enchant_stats_version, 'reroll_count', reroll_count$find$);
  IF v_new=v_def THEN RAISE EXCEPTION 'balance_v3_normal_prepare_patch_failed'; END IF; EXECUTE v_new;

  v_def := pg_get_functiondef('public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure);
  v_new := replace(v_def, 'v_event.location < 10', 'v_event.location < 20');
  v_new := replace(v_new, 'v_gold_per_lane := round((5 + v_event.location)',
    'v_gold_per_lane := round((CASE WHEN v_event.location > 10 THEN (ARRAY[16,17,18,19,20,21,22,23,24,25]::integer[])[v_event.location-10] ELSE 5 + v_event.location END)');
  v_new := replace(v_new, 'round((4 + v_event.location * 1.2) * .55)',
    'CASE WHEN v_event.location > 10 THEN (ARRAY[9,10,11,11,12,13,13,14,15,15]::integer[])[v_event.location-10] ELSE round((4 + v_event.location * 1.2) * .55) END');
  IF v_new=v_def THEN RAISE EXCEPTION 'balance_v3_normal_complete_patch_failed'; END IF; EXECUTE v_new;
END;
$$;

ALTER TABLE public.dungeon_encounters DROP CONSTRAINT dungeon_encounters_balance_version_check;
ALTER TABLE public.dungeon_encounters ADD CONSTRAINT dungeon_encounters_balance_version_check CHECK (char_length(balance_version) BETWEEN 1 AND 180);
ALTER TABLE public.boss_encounters ADD COLUMN balance_version text;
UPDATE public.boss_encounters SET balance_version='2026.08.13-boss-v1' WHERE balance_version IS NULL;
ALTER TABLE public.boss_encounters ALTER COLUMN balance_version SET DEFAULT 'hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc';
ALTER TABLE public.boss_encounters ALTER COLUMN balance_version SET NOT NULL;

CREATE OR REPLACE FUNCTION public.dungeon_star_multiplier(p_stars integer)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT 1::numeric + LEAST(20,GREATEST(0,p_stars)) * .015
$$;

DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.dungeon_roster_snapshot(uuid,jsonb)'::regprocedure);
  v_new := replace(v_def,
    $find$('shepherd', 360::numeric, 72::numeric, 14::numeric, 108::numeric),
      ('assassin', 320, 82, 12, 128), ('knight', 520, 55, 28, 92),
      ('druid', 430, 62, 20, 102), ('archer', 350, 68, 15, 122)$find$,
    $find$('shepherd', 340::numeric, 86::numeric, 12::numeric, 104::numeric),
      ('assassin', 310, 78, 10, 130), ('knight', 500, 56, 28, 92),
      ('druid', 450, 60, 20, 100), ('archer', 360, 70, 14, 124)$find$);
  v_new := replace(v_new,
    $find$('common', 1::numeric), ('uncommon', 1.5), ('rare', 2.2), ('epic', 3.2),
      ('legendary', 4.6), ('mythic', 6.5), ('cosmic', 9), ('divine', 13), ('celestial', 18)$find$,
    $find$('common', 1::numeric), ('uncommon', 1.441163), ('rare', 2.147372), ('epic', 3.084756),
      ('legendary', 4.435796), ('mythic', 6.370091), ('cosmic', 9.143236), ('divine', 13.119459), ('celestial', 18.814853)$find$);
  v_new := replace(v_new,
    'v_enchant_multiplier := 1 + LEAST(10, GREATEST(0, v_item.enchant_level)) * 0.1;',
    'v_enchant_multiplier := 1;');
  v_new := replace(v_new,
    $find$v_stat_value := LEAST(1000000000::numeric, GREATEST(-1000000000::numeric, (v_stat->>'value')::numeric));$find$,
    $find$v_stat_value := LEAST(1000000000::numeric, GREATEST(-1000000000::numeric, (v_stat->>'value')::numeric));
        v_enchant_multiplier := 1 + LEAST(10, GREATEST(0, v_item.enchant_level)) * CASE
          WHEN v_item.enchant_stats_version <> 3 THEN .1
          WHEN v_stat->>'key' IN ('hp','atk','def') THEN .1
          WHEN v_stat->>'key' IN ('goldBonus','xpBonus') THEN .025 ELSE .05 END;$find$);
  v_new := replace(v_new,
    $find$'power', v_item.power, 'enchant_level', v_item.enchant_level, 'reroll_count', v_item.reroll_count$find$,
    $find$'power', v_item.power, 'enchant_level', v_item.enchant_level,
        'enchant_stats_version', v_item.enchant_stats_version, 'reroll_count', v_item.reroll_count$find$);
  v_new := replace(v_new,
    $find$v_hp := round(round(v_base_hp * v_rarity_scale) * 0.2 * (1 + (v_level - 1) * 0.06) * v_star_scale + v_item_hp);
    v_atk := round(round(v_base_atk * v_rarity_scale) * 0.2 * (1 + (v_level - 1) * 0.05) * v_star_scale + v_item_atk);
    v_def := round((round(v_base_def * v_rarity_scale) * 0.2 * v_star_scale + v_item_def)
      * CASE WHEN v_class = 'knight' THEN 1.05 ELSE 1 END);
    v_power := round(v_atk + v_hp * 0.08 + v_def * 1.5 + v_item_attack_speed * 2, 3);$find$,
    $find$v_hp := round((v_base_hp * v_rarity_scale * .2 * (1 + (v_level - 1) *
      CASE v_class WHEN 'knight' THEN .012 WHEN 'shepherd' THEN .007 WHEN 'assassin' THEN .0065
        WHEN 'druid' THEN .0105 ELSE .008 END * (1 + (array_position(ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial'], v_rarity) - 1) * .02))
      * v_star_scale + v_item_hp) * CASE WHEN v_class='knight' THEN 1.15 WHEN v_class='druid' THEN 1.1 ELSE 1 END);
    v_atk := round(v_base_atk * v_rarity_scale * .2 * (1 + (v_level - 1) *
      CASE v_class WHEN 'knight' THEN .0055 WHEN 'shepherd' THEN .0115 WHEN 'assassin' THEN .01
        WHEN 'druid' THEN .0065 ELSE .009 END * (1 + (array_position(ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial'], v_rarity) - 1) * .02))
      * v_star_scale + v_item_atk);
    v_def := round(v_base_def * v_rarity_scale * .2 * (1 + (v_level - 1) *
      CASE v_class WHEN 'knight' THEN .009 WHEN 'shepherd' THEN .0035 WHEN 'assassin' THEN .003
        WHEN 'druid' THEN .0065 ELSE .0045 END * (1 + (array_position(ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial'], v_rarity) - 1) * .02))
      * v_star_scale + v_item_def);
    v_base_speed := v_base_speed * (1 + (array_position(ARRAY['common','uncommon','rare','epic','legendary','mythic','cosmic','divine','celestial'], v_rarity) - 1) * .01) + v_stars * .1;
    v_power := round(v_atk + v_hp * .08 + v_def * 1.5 + v_item_attack_speed * 2, 3);$find$);
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v3_dungeon_snapshot_patch_failed'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.dungeon_start(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def, '''2026.08.13-dungeon-core-v1''',
    '''hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc''');
  IF v_new=v_def THEN RAISE EXCEPTION 'balance_v3_dungeon_start_patch_failed'; END IF; EXECUTE v_new;

  v_def := pg_get_functiondef('public.summon_boss(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def, '''2026.08.24-boss-hunt-v1''',
    '''hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc''');
  IF v_new=v_def THEN RAISE EXCEPTION 'balance_v3_boss_start_patch_failed'; END IF; EXECUTE v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.roll_item_stats_v3(text,text,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.calculate_item_power_v3(jsonb,integer) FROM PUBLIC,anon,authenticated;
