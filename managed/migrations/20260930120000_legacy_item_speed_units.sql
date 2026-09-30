-- Correct legacy Attack Speed units without rewriting any item, save or currency row.
-- Non-percent rolls are milliseconds; percent rolls are already fractional bonus points.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.dungeon_roster_snapshot(uuid,jsonb)'::regprocedure);
  v_new := replace(v_def,
    $find$        v_enchant_multiplier := public.enchant_v6_multiplier(v_item.enchant_level);
        CASE v_stat->>'key'$find$,
    $replace$        v_enchant_multiplier := public.enchant_v6_multiplier(v_item.enchant_level);
        IF v_stat->>'key' = 'atkSpeed' AND NOT COALESCE((v_stat->>'isPercent')::boolean, false) THEN
          v_stat_value := v_stat_value / 1000;
        END IF;
        CASE v_stat->>'key'$replace$);
  IF v_new = v_def THEN RAISE EXCEPTION 'legacy_item_speed_snapshot_patch_failed'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.dungeon_equipment_combat_stat(jsonb,text)'::regprocedure);
  v_new := replace(v_def,
    $find$(stat->>'value')::numeric * ($find$,
    $replace$(stat->>'value')::numeric / CASE
      WHEN stat->>'key' = 'atkSpeed' AND NOT COALESCE((stat->>'isPercent')::boolean, false) THEN 1000
      ELSE 1 END * ($replace$);
  IF v_new = v_def THEN RAISE EXCEPTION 'legacy_item_speed_equipment_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;

-- Verify both unit representations and an enchanted legacy line during migration replay.
DO $$
DECLARE
  v_hero jsonb := '{"equipment":[{"enchant_level":0,"stats":[{"key":"atkSpeed","value":26,"isPercent":false}]}]}'::jsonb;
BEGIN
  IF public.dungeon_equipment_combat_stat(v_hero, 'atkSpeed') <> .026 THEN
    RAISE EXCEPTION 'legacy_item_speed_milliseconds_failed';
  END IF;
  v_hero := jsonb_set(v_hero, '{equipment,0,stats,0}', '{"key":"atkSpeed","value":0.026,"isPercent":true}'::jsonb);
  IF public.dungeon_equipment_combat_stat(v_hero, 'atkSpeed') <> .026 THEN
    RAISE EXCEPTION 'legacy_item_speed_percent_failed';
  END IF;
  v_hero := '{"equipment":[{"enchant_level":1,"stats":[{"key":"atkSpeed","value":26,"isPercent":false}]}]}'::jsonb;
  IF public.dungeon_equipment_combat_stat(v_hero, 'atkSpeed') <> .029 THEN
    RAISE EXCEPTION 'legacy_item_speed_enchant_failed';
  END IF;
END;
$$;
