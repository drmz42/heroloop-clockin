-- Forward-only: Tutorial steps 7 and 9 count verified enemy kills instead of Training Camp
-- and Location 2, which needed Account Level 2 and 5. Rewards and other steps are unchanged.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.tutorial_quest_progress(jsonb,integer)'::regprocedure);
  v_new := regexp_replace(v_def, 'WHEN 7 THEN .*?(\n\s*WHEN 8 )',
    E'WHEN 7 THEN GREATEST(0, COALESCE((p_state->>''totalKills'')::bigint, 0))\\1');
  v_new := regexp_replace(v_new, 'WHEN 9 THEN .*?(\n\s*WHEN 10 )',
    E'WHEN 9 THEN GREATEST(0, COALESCE((p_state->>''totalKills'')::bigint, 0))\\1');
  IF v_new = v_def OR v_new LIKE '%trainingCamp%' OR v_new LIKE '%highestLocation%' THEN
    RAISE EXCEPTION 'tutorial_level_free_progress_patch_failed';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_tutorial_quest_claim(uuid,uuid,text,bigint)'::regprocedure);
  v_new := replace(replace(replace(v_def,
    '''assign-training-hero''', '''defeat-25-enemies'''),
    '''reach-location-2''', '''defeat-50-enemies'''),
    'ARRAY[10,10,1,2,3,3,1,1,2,1]', 'ARRAY[10,10,1,2,3,3,25,1,50,1]');
  IF v_new LIKE '%assign-training-hero%' OR v_new LIKE '%reach-location-2%' OR v_new NOT LIKE '%ARRAY[10,10,1,2,3,3,25,1,50,1]%' THEN
    RAISE EXCEPTION 'tutorial_level_free_claim_patch_failed';
  END IF;
  EXECUTE v_new;
END $$;
