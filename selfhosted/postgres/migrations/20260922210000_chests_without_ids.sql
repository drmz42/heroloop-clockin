\set ON_ERROR_STOP on

-- Chests are fungible server-only rewards ({stage, boss?, tutorial?}); they are
-- never traded, so they no longer carry an id. The server owns the chest list
-- (the save filter no longer reads browser chests), the 500 cap and daily cap
-- are unchanged, and grants stay auditable through their settlement events.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, $f$IF v_chest_id = '' THEN RAISE EXCEPTION 'invalid_chest'; END IF;$f$, ''))) = 0
    OR (length(v_def) - length(replace(v_def, $f$'standard_chest' END, v_chest_id$f$, ''))) = 0 THEN
    RAISE EXCEPTION 'chest_open_patch_target_missing';
  END IF;
  v_new := replace(v_def,
    $f$IF v_chest_id = '' THEN RAISE EXCEPTION 'invalid_chest'; END IF;$f$,
    $f$IF jsonb_typeof(v_chest) <> 'object' THEN RAISE EXCEPTION 'invalid_chest'; END IF;$f$);
  v_new := replace(v_new,
    $f$'standard_chest' END, v_chest_id$f$,
    $f$'standard_chest' END, NULLIF(v_chest_id, '')$f$);
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.boss_claim(uuid,uuid,bigint,uuid)'::regprocedure);
  v_new := replace(v_def,
    $f$jsonb_build_object('id', 'boss-' || v_boss.id::text, 'stage', v_boss.location_id, 'boss', true)$f$,
    $f$jsonb_build_object('stage', v_boss.location_id, 'boss', true)$f$);
  IF v_new = v_def THEN RAISE EXCEPTION 'boss_claim_patch_target_missing'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_periodic_progression_legacy(uuid,timestamptz)'::regprocedure);
  v_new := replace(v_def,
    $f$jsonb_build_object('id', public.new_chest_id(), 'stage', $f$,
    $f$jsonb_build_object('stage', $f$);
  IF v_new = v_def THEN RAISE EXCEPTION 'periodic_chest_patch_target_missing'; END IF;
  EXECUTE v_new;
END
$$;

DROP FUNCTION public.new_chest_id();

UPDATE public.player_saves
SET state = jsonb_set(state, '{chests}', (
      SELECT COALESCE(jsonb_agg(chest.value - 'id' ORDER BY chest.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(state->'chests') WITH ORDINALITY chest(value, ordinality)
    ), true),
    updated_at = now()
WHERE jsonb_typeof(state->'chests') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(state->'chests') chest WHERE chest.value ? 'id');
