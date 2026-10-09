-- Preserve matched-guard priority, then assist living summons before returning to the Boss.
-- Forward-only; existing encounter results and reward settlement are unchanged.
DO $$
DECLARE
  v_name text;
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['dungeon_shared_boss_basic_action', 'dungeon_shared_boss_v2_basic_action'] LOOP
    v_definition := pg_get_functiondef(('public.' || v_name || '(uuid,uuid,bigint,text,uuid)')::regprocedure);
    IF position('summon_priority_fix' in v_definition) > 0 THEN CONTINUE; END IF;
    v_old := CASE WHEN v_name = 'dungeon_shared_boss_basic_action'
      THEN 'WHERE side = ''enemy'' AND position = v_actor.position AND alive'
      ELSE 'WHERE side=''enemy'' AND position=v_actor.position AND alive' END;
    IF position(v_old in v_definition) = 0
      OR position('necromancer-summon-' in v_definition) = 0 THEN
      RAISE EXCEPTION 'dungeon_summon_priority_definition_mismatch: %', v_name;
    END IF;
    v_new := v_old || E'\n        AND (unit_id NOT LIKE ''shared-boss-%'' OR NOT EXISTS (' ||
      'SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side=''enemy'' AND alive ' ||
      'AND unit_id LIKE ''necromancer-summon-%'')) /* summon_priority_fix */';
    v_definition := replace(v_definition, v_old, v_new);
    IF v_name = 'dungeon_shared_boss_basic_action' THEN
      v_old := 'ORDER BY current_hp / NULLIF(max_hp, 0), position, unit_id LIMIT 1';
      IF position(v_old in v_definition) = 0 THEN
        RAISE EXCEPTION 'dungeon_summon_fallback_definition_mismatch';
      END IF;
      v_definition := replace(v_definition, v_old,
        'ORDER BY CASE WHEN unit_id LIKE ''shared-boss-%'' THEN 1 ELSE 0 END, current_hp / NULLIF(max_hp, 0), position, unit_id LIMIT 1');
    END IF;
    EXECUTE v_definition;
  END LOOP;
END $$;
