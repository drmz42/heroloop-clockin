CREATE OR REPLACE FUNCTION public.normal_combat_elite_reward_multiplier(
  p_location integer, p_initial_units jsonb
)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public
AS $$
DECLARE
  v_enemy_count integer;
  v_affix_count integer;
  v_affix text;
BEGIN
  IF p_location NOT BETWEEN 11 AND 20 OR jsonb_typeof(p_initial_units) IS DISTINCT FROM 'array' THEN
    RETURN 1::numeric;
  END IF;
  SELECT count(*), count(DISTINCT unit->>'eliteAffix'), min(unit->>'eliteAffix')
  INTO v_enemy_count, v_affix_count, v_affix
  FROM jsonb_array_elements(p_initial_units) unit
  WHERE unit->>'side' = 'enemy';
  IF v_enemy_count NOT BETWEEN 1 AND 3 OR v_affix_count <> 1
    OR v_affix NOT IN ('guard-aura','mending','barrier','enrage','curse','lane-blast','summoner')
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_initial_units) unit
      WHERE unit->>'side' = 'enemy' AND unit->>'eliteAffix' IS DISTINCT FROM v_affix
    ) THEN
    RETURN 1::numeric;
  END IF;
  RETURN 1.5::numeric;
END;
$$;

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure);
  v_new := replace(v_def, 'v_xp_per_lane integer;', 'v_xp_per_lane integer;
  v_elite_multiplier numeric := 1;');
  v_new := replace(v_new,
    'SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_dead FROM jsonb_array_elements_text(v_event.outcome->''dead_hero_uids'');',
    'SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_dead FROM jsonb_array_elements_text(v_event.outcome->''dead_hero_uids'');
  v_elite_multiplier := public.normal_combat_elite_reward_multiplier(v_event.location, v_event.initial_units);');
  v_new := replace(v_new,
    'v_gold_per_lane := round((CASE WHEN v_event.location > 10 THEN (ARRAY[16,17,18,19,20,21,22,23,24,25]::integer[])[v_event.location-10] ELSE 5 + v_event.location END) *',
    'v_gold_per_lane := round((CASE WHEN v_event.location > 10 THEN (ARRAY[16,17,18,19,20,21,22,23,24,25]::integer[])[v_event.location-10] ELSE 5 + v_event.location END) * v_elite_multiplier *');
  v_new := replace(v_new,
    'CASE WHEN v_event.location > 10 THEN (ARRAY[9,10,11,11,12,13,13,14,15,15]::integer[])[v_event.location-10] ELSE round((4 + v_event.location * 1.2) * .55) END)',
    'CASE WHEN v_event.location > 10 THEN (ARRAY[9,10,11,11,12,13,13,14,15,15]::integer[])[v_event.location-10] ELSE round((4 + v_event.location * 1.2) * .55) END) * v_elite_multiplier');
  v_new := replace(v_new,
    $find$'hero_xp_per_winner', v_xp_per_lane, 'kills', v_cleared$find$,
    $find$'hero_xp_per_winner', v_xp_per_lane, 'kills', v_cleared,
      'elite_multiplier', v_elite_multiplier$find$);
  IF v_new = v_def OR position('v_elite_multiplier numeric := 1;' IN v_new) = 0
    OR position('normal_combat_elite_reward_multiplier(v_event.location, v_event.initial_units)' IN v_new) = 0
    OR position('''elite_multiplier'', v_elite_multiplier' IN v_new) = 0 THEN
    RAISE EXCEPTION 'locations_11_20_elite_reward_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;

REVOKE ALL ON FUNCTION public.normal_combat_elite_reward_multiplier(integer, jsonb) FROM PUBLIC, anon, authenticated;
