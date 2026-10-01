-- Forward-only tutorial corrections. No historical rewards or saves are rewritten.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.tutorial_quest_progress(jsonb,integer)'::regprocedure);
  v_new := replace(v_def,
    $find$WHEN 9 THEN GREATEST(0, COALESCE((p_state->>'highestLocation')::bigint, 0))$find$,
    $patch$WHEN 9 THEN LEAST(GREATEST(0, COALESCE((p_state->>'highestLocation')::bigint, 0)),
      public.balance_v6_location_cap(GREATEST(1, COALESCE((p_state->>'accountLevel')::integer, 1))))$patch$);
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_location_patch_failed'; END IF;
  EXECUTE v_new;

  -- The first item is a class-independent helmet at the account's level.
  -- Keep the standard rarity roll and v5 stat/Power generation unchanged.
  v_def := pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  v_new := replace(v_def,
    'v_stats := public.roll_item_stats_v5(v_slot, v_rarity, v_item_level, v_base_item_id);',
    $patch$IF i = 1 AND COALESCE((v_chest->>'tutorial')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM public.tutorial_chest_open_events WHERE player_id = p_player_id) THEN
      v_slot := 'helmet';
      v_base_item_id := 'helmet-' || v_rarity;
      v_item_level := LEAST(99, v_level);
    END IF;
    v_stats := public.roll_item_stats_v5(v_slot, v_rarity, v_item_level, v_base_item_id);$patch$);
  IF v_new = v_def THEN RAISE EXCEPTION 'tutorial_starter_item_patch_failed'; END IF;
  EXECUTE v_new;

END $$;
