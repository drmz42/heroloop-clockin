ALTER TABLE public.players
  ADD COLUMN normal_combat_hp jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(normal_combat_hp) = 'object'),
  ADD COLUMN normal_combat_reward_progress numeric NOT NULL DEFAULT 0
    CHECK (normal_combat_reward_progress >= 0 AND normal_combat_reward_progress < 12);

-- The authoritative combat builder receives HP from a server-only player
-- column. A browser save cannot heal or damage the next wave by changing JSON.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.normal_combat_prepare(uuid,uuid,integer)'::regprocedure);
  v_new := replace(v_def, 'v_seed integer;', 'v_seed integer;
  v_normal_combat_hp jsonb;');
  v_new := replace(v_new,
    'SELECT normal_combat_mode INTO v_normal_mode FROM public.players WHERE player_id = p_player_id FOR UPDATE;',
    'SELECT normal_combat_mode, normal_combat_hp INTO v_normal_mode, v_normal_combat_hp FROM public.players WHERE player_id = p_player_id FOR UPDATE;');
  v_new := replace(v_new,
    $find$'needs_simulation', true, 'state', v_save.state, 'ledger_items', v_ledger$find$,
    $find$'needs_simulation', true, 'state', v_save.state || jsonb_build_object('normalCombatHp', v_normal_combat_hp), 'ledger_items', v_ledger$find$);
  IF v_new = v_def OR position('v_normal_combat_hp jsonb;' IN v_new) = 0
    OR position('normal_combat_hp INTO v_normal_mode, v_normal_combat_hp' IN v_new) = 0
    OR position('jsonb_build_object(''normalCombatHp'', v_normal_combat_hp)' IN v_new) = 0 THEN
    RAISE EXCEPTION 'normal_combat_hp_prepare_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;

-- The resolver already owns elapsed_ms. Replace the fixed twelve-second empty
-- battlefield with a deterministic 500 ms server handoff; the client retains
-- its existing 250 ms result handoff. Reward pacing is enforced separately in
-- normal_combat_complete_without_auto_pot below.
CREATE OR REPLACE FUNCTION public.normal_combat_store_outcome(
  p_player_id uuid, p_start_key uuid, p_initial_units jsonb, p_reward_bonuses jsonb, p_outcome jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_event public.normal_combat_events%ROWTYPE;
BEGIN
  IF NOT public.normal_combat_auto_potions_valid(p_initial_units, p_outcome) THEN
    RAISE EXCEPTION 'normal_combat_invalid_outcome';
  END IF;
  v_result := public.normal_combat_store_outcome_without_auto_pot(
    p_player_id, p_start_key, p_initial_units, p_reward_bonuses, p_outcome
  );
  UPDATE public.normal_combat_events
  SET available_at = started_at
    + make_interval(secs => COALESCE((outcome->>'elapsed_ms')::numeric, 0) / 1000)
    + interval '500 milliseconds'
  WHERE start_key = p_start_key AND player_id = p_player_id
  RETURNING * INTO STRICT v_event;
  RETURN public.normal_combat_event_result(v_event, COALESCE((v_result->>'resumed')::boolean, false));
END;
$$;

-- Completion always persists server-derived HP/death state. Gold, XP, kills,
-- quests and Location progress settle only when the server-owned clock has
-- accumulated a complete twelve seconds. Sequential waves cannot overlap, so
-- credited time can never exceed real elapsed time; replay returns stored data
-- before touching either clock or HP.
CREATE OR REPLACE FUNCTION public.normal_combat_complete_without_auto_pot(
  p_player_id uuid, p_start_key uuid, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_existing public.normal_combat_completion_events%ROWTYPE;
  v_event public.normal_combat_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_heroes jsonb;
  v_hero jsonb;
  v_won text[];
  v_dead text[];
  v_uid text;
  v_level integer;
  v_remaining bigint;
  v_index integer;
  v_cleared integer;
  v_outcome_cleared integer;
  v_gold_per_lane integer;
  v_xp_per_lane integer;
  v_elite_multiplier numeric := 1;
  v_gold bigint;
  v_account_xp bigint;
  v_total_xp bigint;
  v_account_level integer := 1;
  v_account_start bigint := 0;
  v_now_ms bigint := floor(extract(epoch FROM now()) * 1000);
  v_wave_seconds numeric;
  v_reward_progress numeric;
  v_rewarded_wave integer;
  v_next_hp jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('normal-combat:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.normal_combat_completion_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.start_key <> p_start_key THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_event FROM public.normal_combat_events WHERE start_key = p_start_key FOR UPDATE;
  IF NOT FOUND OR v_event.player_id <> p_player_id THEN RAISE EXCEPTION 'normal_combat_not_found'; END IF;
  IF v_event.result IS NOT NULL THEN
    v_result := v_event.result || jsonb_build_object('replayed', true);
    INSERT INTO public.normal_combat_completion_events(idempotency_key, player_id, start_key, result)
    VALUES (p_idempotency_key, p_player_id, p_start_key, v_result);
    RETURN v_result;
  END IF;
  IF v_event.outcome IS NULL THEN RAISE EXCEPTION 'normal_combat_not_ready'; END IF;
  IF now() < v_event.available_at THEN RAISE EXCEPTION 'normal_combat_too_early'; END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT normal_combat_reward_progress INTO v_reward_progress
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  v_state := v_save.state;
  v_wave_seconds := LEAST(12::numeric, GREATEST(0::numeric, extract(epoch FROM (now() - v_event.started_at))));
  v_reward_progress := v_reward_progress + v_wave_seconds;
  v_rewarded_wave := LEAST(1, floor(v_reward_progress / 12)::integer);
  v_reward_progress := v_reward_progress - v_rewarded_wave * 12;
  v_outcome_cleared := GREATEST(0, LEAST(3, COALESCE((v_event.outcome->>'cleared_lanes')::integer, 0)));
  v_cleared := v_outcome_cleared * v_rewarded_wave;
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_won FROM jsonb_array_elements_text(v_event.outcome->'won_hero_uids');
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_dead FROM jsonb_array_elements_text(v_event.outcome->'dead_hero_uids');
  SELECT COALESCE(jsonb_object_agg(unit->>'uid', to_jsonb(
    GREATEST(0, LEAST((unit->>'maxHp')::numeric, (unit->>'hp')::numeric))
  )), '{}'::jsonb) INTO v_next_hp
  FROM jsonb_array_elements(v_event.outcome->'final_units') unit
  WHERE unit->>'side' = 'hero';

  v_elite_multiplier := public.normal_combat_elite_reward_multiplier(v_event.location, v_event.initial_units);
  v_gold_per_lane := round((CASE WHEN v_event.location > 10 THEN (ARRAY[16,17,18,19,20,21,22,23,24,25]::integer[])[v_event.location-10] ELSE 5 + v_event.location END) * v_elite_multiplier
    * (1 + LEAST(10, GREATEST(0, COALESCE((v_event.reward_bonuses->>'gold')::numeric, 0)))))::integer;
  v_xp_per_lane := round(GREATEST(1, CASE WHEN v_event.location > 10 THEN (ARRAY[9,10,11,11,12,13,13,14,15,15]::integer[])[v_event.location-10] ELSE round((4 + v_event.location * 1.2) * .55) END) * v_elite_multiplier
    * (1 + LEAST(10, GREATEST(0, COALESCE((v_event.reward_bonuses->>'xp')::numeric, 0)))))::integer;
  v_gold := v_gold_per_lane * v_cleared;
  v_account_xp := v_xp_per_lane * v_cleared;

  v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold));
  v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold));
  v_state := jsonb_set(v_state, '{totalKills}', to_jsonb(COALESCE((v_state->>'totalKills')::bigint, 0) + v_cleared));
  v_state := jsonb_set(v_state, '{session,kills}', to_jsonb(COALESCE((v_state#>>'{session,kills}')::bigint, 0) + v_cleared));
  v_state := jsonb_set(v_state, '{session,goldToday}', to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint, 0) + v_gold));
  v_total_xp := COALESCE((v_state->>'accountXp')::bigint, 0) + v_account_xp;
  WHILE v_account_level < 99 AND v_total_xp >= v_account_start + public.account_xp_needed(v_account_level) LOOP
    v_account_start := v_account_start + public.account_xp_needed(v_account_level);
    v_account_level := v_account_level + 1;
  END LOOP;
  v_state := jsonb_set(v_state, '{accountXp}', to_jsonb(v_total_xp));
  v_state := jsonb_set(v_state, '{accountLevel}', to_jsonb(v_account_level));
  v_heroes := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_array_length(v_heroes) > 0 THEN
    FOR v_index IN 0..jsonb_array_length(v_heroes) - 1 LOOP
      v_hero := v_heroes->v_index;
      v_uid := v_hero->>'uid';
      IF v_rewarded_wave = 1 AND v_uid = ANY(v_won) THEN
        v_level := GREATEST(1, LEAST(99, COALESCE((v_hero->>'level')::integer, 1)));
        v_remaining := GREATEST(0, COALESCE((v_hero->>'xp')::bigint, 0)) + v_xp_per_lane;
        WHILE v_level < 99 AND v_remaining >= public.hero_xp_needed(v_level) LOOP
          v_remaining := v_remaining - public.hero_xp_needed(v_level); v_level := v_level + 1;
        END LOOP;
        IF v_level >= 99 THEN v_remaining := 0; END IF;
        v_hero := jsonb_set(jsonb_set(v_hero, '{level}', to_jsonb(v_level)), '{xp}', to_jsonb(v_remaining));
      END IF;
      IF v_uid = ANY(v_dead) THEN
        v_hero := jsonb_set(v_hero, '{respawnAt}', to_jsonb(v_now_ms + 15000));
      ELSIF COALESCE((v_next_hp->>v_uid)::numeric, 0) > 0 THEN
        v_hero := v_hero - 'respawnAt';
      END IF;
      v_heroes := jsonb_set(v_heroes, ARRAY[v_index::text], v_hero);
    END LOOP;
  END IF;
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.normal_combat_advance_quests(v_state->'dailyQuests', 'kill-', v_cleared));
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'kill-', v_cleared));
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'gold-earned-', v_gold));
  IF v_rewarded_wave = 1 AND COALESCE((v_event.outcome->>'all_cleared')::boolean, false)
    AND v_event.location = COALESCE((v_state->>'highestLocation')::integer, 1)
    AND v_event.location < 20 THEN
    v_state := jsonb_set(v_state, '{highestLocation}', to_jsonb(v_event.location + 1));
  END IF;
  v_state := jsonb_set(v_state, '{combatXpAt}', to_jsonb(v_now_ms));
  v_state := jsonb_set(v_state, '{lastSeen}', to_jsonb(v_now_ms));

  UPDATE public.players SET normal_combat_hp = v_next_hp,
    normal_combat_reward_progress = v_reward_progress, updated_at = now()
  WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING * INTO v_save;
  v_result := jsonb_build_object(
    'wave_id', v_event.id, 'start_key', v_event.start_key, 'revision', v_save.revision,
    'state', v_save.state, 'outcome', v_event.outcome,
    'rewards', jsonb_build_object('gold', v_gold, 'account_xp', v_account_xp,
      'hero_xp_per_winner', CASE WHEN v_rewarded_wave = 1 THEN v_xp_per_lane ELSE 0 END,
      'kills', v_cleared, 'elite_multiplier', v_elite_multiplier,
      'rewarded_wave', v_rewarded_wave = 1, 'reward_clock_seconds', v_wave_seconds),
    'replayed', false
  );
  UPDATE public.normal_combat_events SET completed_at = now(), result = v_result WHERE start_key = p_start_key;
  INSERT INTO public.normal_combat_completion_events(idempotency_key, player_id, start_key, result)
  VALUES (p_idempotency_key, p_player_id, p_start_key, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_complete_without_auto_pot(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) TO service_role;
