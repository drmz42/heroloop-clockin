-- Balance v5 Staging candidate. Existing encounter snapshots and item rows stay immutable.
CREATE OR REPLACE FUNCTION public.dungeon_star_multiplier(p_stars integer)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT 1::numeric + LEAST(20, GREATEST(0, p_stars)) * .05
$$;

CREATE OR REPLACE FUNCTION public.hero_level_mastery(p_level integer)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT 1::numeric + .75 * (LEAST(99, GREATEST(1, p_level)) - 1) / 79
$$;
REVOKE ALL ON FUNCTION public.hero_level_mastery(integer) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- Dungeon and Boss encounters snapshot the roster when they start. Only newly
  -- started encounters use the new Hero Level mastery and Star curve.
  v_def := pg_get_functiondef('public.dungeon_roster_snapshot(uuid,jsonb)'::regprocedure);
  v_new := replace(v_def,
    'v_power := round(v_atk + v_hp * 0.08 + v_def * 1.5 + v_item_attack_speed * 2, 3);',
    'v_hp := round(v_hp * public.hero_level_mastery(v_level));
    v_atk := round(v_atk * public.hero_level_mastery(v_level));
    v_def := round(v_def * public.hero_level_mastery(v_level));
    v_power := round(v_atk + v_hp * 0.08 + v_def * 1.5 + v_item_attack_speed * 2, 3);');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v5_dungeon_snapshot_patch_failed'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.dungeon_start(uuid,integer,uuid)'::regprocedure);
  v_new := replace(v_def,
    'hero-power-proposal-2026.08.12-v3@sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc',
    'balance-v5-progression-2026.09.28-v1');
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v5_dungeon_version_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;

ALTER TABLE public.normal_combat_events
  ALTER COLUMN balance_version SET DEFAULT 'balance-v5-progression-2026.09.28-v1';
ALTER TABLE public.boss_encounters
  ALTER COLUMN balance_version SET DEFAULT 'balance-v5-progression-2026.09.28-v1';
