-- A hero who entered a wave already dead is still waiting on the existing
-- recovery deadline. Replaying that dead slot must not start a new deadline.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef(
    'public.normal_combat_complete_without_auto_pot(uuid,uuid,uuid)'::regprocedure
  );
  v_new := replace(v_def,
    $find$IF v_uid = ANY(v_dead) THEN
        v_hero := jsonb_set(v_hero, '{respawnAt}', to_jsonb(v_now_ms + 15000));
      ELSIF COALESCE((v_next_hp->>v_uid)::numeric, 0) > 0 THEN$find$,
    $replace$IF v_uid = ANY(v_dead) AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_event.initial_units) initial_unit
        WHERE initial_unit->>'side' = 'hero'
          AND initial_unit->>'uid' = v_uid
          AND COALESCE((initial_unit->>'hp')::numeric, 0) > 0
      ) THEN
        v_hero := jsonb_set(v_hero, '{respawnAt}', to_jsonb(v_now_ms + 15000));
      ELSIF COALESCE((v_next_hp->>v_uid)::numeric, 0) > 0 THEN$replace$);
  IF v_new = v_def
    OR position('jsonb_array_elements(v_event.initial_units) initial_unit' IN v_new) = 0
    OR position('COALESCE((initial_unit->>''hp'')::numeric, 0) > 0' IN v_new) = 0 THEN
    RAISE EXCEPTION 'normal_combat_respawn_deadline_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;
