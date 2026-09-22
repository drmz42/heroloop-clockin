CREATE OR REPLACE FUNCTION public.credit_tester_progression(
  p_player_id uuid,
  p_kind text,
  p_amount bigint DEFAULT 2000
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_total_xp bigint;
  v_max_xp bigint := 0;
  v_account_level integer := 1;
  v_account_start bigint := 0;
  v_heroes jsonb;
  v_hero jsonb;
  v_team jsonb;
  v_level integer;
  v_remaining bigint;
  v_index integer;
BEGIN
  IF p_amount <> 2000 OR p_kind NOT IN ('account_xp', 'formation_xp') THEN
    RAISE EXCEPTION 'invalid_tester_progression_credit';
  END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_state := v_save.state;

  IF p_kind = 'account_xp' THEN
    FOR v_level IN 1..98 LOOP
      v_max_xp := v_max_xp + public.account_xp_needed(v_level);
    END LOOP;
    v_total_xp := LEAST(v_max_xp, GREATEST(0, COALESCE((v_state->>'accountXp')::bigint, 0)) + p_amount);
    WHILE v_account_level < 99 AND v_total_xp >= v_account_start + public.account_xp_needed(v_account_level) LOOP
      v_account_start := v_account_start + public.account_xp_needed(v_account_level);
      v_account_level := v_account_level + 1;
    END LOOP;
    v_state := jsonb_set(v_state, '{accountXp}', to_jsonb(v_total_xp));
    v_state := jsonb_set(v_state, '{accountLevel}', to_jsonb(v_account_level));
  ELSE
    v_account_level := GREATEST(1, LEAST(99, COALESCE((v_state->>'accountLevel')::integer, 1)));
    v_heroes := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
    v_team := COALESCE(v_state->'team', '[]'::jsonb);
    IF jsonb_array_length(v_heroes) > 0 THEN
      FOR v_index IN 0..jsonb_array_length(v_heroes) - 1 LOOP
        v_hero := v_heroes->v_index;
        v_level := GREATEST(1, LEAST(99, COALESCE((v_hero->>'level')::integer, 1)));
        IF v_team ? (v_hero->>'uid') AND v_level < v_account_level THEN
          v_remaining := GREATEST(0, COALESCE((v_hero->>'xp')::bigint, 0)) + p_amount;
          WHILE v_level < v_account_level AND v_remaining >= public.hero_xp_needed(v_level) LOOP
            v_remaining := v_remaining - public.hero_xp_needed(v_level);
            v_level := v_level + 1;
          END LOOP;
          IF v_level >= v_account_level THEN v_remaining := 0; END IF;
          v_hero := jsonb_set(jsonb_set(v_hero, '{level}', to_jsonb(v_level)), '{xp}', to_jsonb(v_remaining));
          v_heroes := jsonb_set(v_heroes, ARRAY[v_index::text], v_hero);
        END IF;
      END LOOP;
    END IF;
    v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes);
  END IF;

  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id
  RETURNING * INTO v_save;

  RETURN jsonb_build_object(
    'kind', p_kind,
    'credited', p_amount,
    'revision', v_save.revision,
    'state', v_save.state
  );
END;
$$;

REVOKE ALL ON FUNCTION public.credit_tester_progression(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_tester_progression(uuid, text, bigint) TO service_role;
