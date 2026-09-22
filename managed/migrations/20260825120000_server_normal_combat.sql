ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS normal_combat_mode boolean NOT NULL DEFAULT false;

ALTER FUNCTION public.settle_periodic_progression(uuid, timestamptz)
  RENAME TO settle_periodic_progression_legacy;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression(p_player_id uuid, p_tick timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_normal_mode boolean;
  v_online boolean;
  v_combat_power bigint;
  v_result jsonb;
BEGIN
  SELECT normal_combat_mode, online, combat_power
  INTO v_normal_mode, v_online, v_combat_power
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;

  -- While the browser is actively settling exact normal waves, the periodic
  -- worker owns only timed chests. The legacy function already has the correct
  -- chest clock/caps and skips combat when canonical combat Power is zero.
  IF v_normal_mode AND (v_online OR EXISTS (
    SELECT 1 FROM public.normal_combat_events event
    WHERE event.player_id = p_player_id AND event.completed_at IS NULL
  )) THEN
    UPDATE public.players SET combat_power = 0 WHERE player_id = p_player_id;
    v_result := public.settle_periodic_progression_legacy(p_player_id, p_tick);
    UPDATE public.players SET combat_power = v_combat_power WHERE player_id = p_player_id;
    RETURN v_result;
  END IF;
  RETURN public.settle_periodic_progression_legacy(p_player_id, p_tick);
END;
$$;

CREATE TABLE public.normal_combat_events (
  start_key uuid PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  location integer NOT NULL CHECK (location BETWEEN 1 AND 10),
  seed integer NOT NULL CHECK (seed > 0),
  state_revision bigint NOT NULL CHECK (state_revision > 0),
  initial_units jsonb,
  reward_bonuses jsonb,
  outcome jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL,
  completed_at timestamptz,
  result jsonb,
  CHECK (initial_units IS NULL OR jsonb_typeof(initial_units) = 'array'),
  CHECK (reward_bonuses IS NULL OR jsonb_typeof(reward_bonuses) = 'object'),
  CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);
CREATE INDEX normal_combat_events_player_started ON public.normal_combat_events(player_id, started_at DESC);
CREATE UNIQUE INDEX normal_combat_events_one_pending ON public.normal_combat_events(player_id) WHERE completed_at IS NULL;

CREATE TABLE public.normal_combat_completion_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  start_key uuid NOT NULL REFERENCES public.normal_combat_events(start_key) ON DELETE CASCADE,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.normal_combat_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.normal_combat_completion_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.normal_combat_events, public.normal_combat_completion_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.normal_combat_event_result(p_event public.normal_combat_events, p_resumed boolean)
RETURNS jsonb
LANGUAGE sql STABLE STRICT SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'wave_id', p_event.id,
    'start_key', p_event.start_key,
    'location', p_event.location,
    'seed', p_event.seed,
    'started_at', p_event.started_at,
    'available_at', p_event.available_at,
    'initial_units', p_event.initial_units,
    'reward_bonuses', p_event.reward_bonuses,
    'outcome', p_event.outcome,
    'completed', p_event.completed_at IS NOT NULL,
    'result', p_event.result,
    'resumed', p_resumed
  )
$$;

CREATE OR REPLACE FUNCTION public.normal_combat_prepare(
  p_player_id uuid, p_start_key uuid, p_location integer
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_event public.normal_combat_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_normal_mode boolean;
  v_location_cap integer;
  v_ledger jsonb;
  v_seed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('normal-combat:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_start_key::text, 0));
  SELECT * INTO v_event FROM public.normal_combat_events WHERE start_key = p_start_key FOR UPDATE;
  IF FOUND THEN
    IF v_event.player_id <> p_player_id OR v_event.location <> p_location THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN public.normal_combat_event_result(v_event, true) || jsonb_build_object('needs_simulation', v_event.outcome IS NULL);
  END IF;
  SELECT * INTO v_event FROM public.normal_combat_events
  WHERE player_id = p_player_id AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN public.normal_combat_event_result(v_event, true) || jsonb_build_object('needs_simulation', v_event.outcome IS NULL);
  END IF;
  IF p_location IS NULL OR p_location NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'normal_combat_invalid_location'; END IF;
  IF EXISTS (SELECT 1 FROM public.dungeon_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.boss_encounters WHERE player_id = p_player_id AND status = 'active') THEN
    RAISE EXCEPTION 'active_encounter_exists';
  END IF;
  SELECT normal_combat_mode INTO v_normal_mode FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_required'; END IF;
  IF NOT v_normal_mode THEN
    PERFORM public.settle_periodic_progression_legacy(p_player_id, now());
  END IF;
  UPDATE public.players
  SET normal_combat_mode = true, resource_reward_at = GREATEST(resource_reward_at, now()), updated_at = now()
  WHERE player_id = p_player_id;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_location_cap := CASE
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 70 THEN 10
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 60 THEN 9
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 50 THEN 8
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 40 THEN 7
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 31 THEN 6
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 23 THEN 5
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 16 THEN 4
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 10 THEN 3
    WHEN COALESCE((v_save.state->>'accountLevel')::integer, 1) >= 5 THEN 2 ELSE 1 END;
  IF p_location > LEAST(GREATEST(1, COALESCE((v_save.state->>'highestLocation')::integer, 1)), v_location_cap)
    OR p_location < GREATEST(1, LEAST(GREATEST(1, COALESCE((v_save.state->>'highestLocation')::integer, 1)), v_location_cap) - 1)
  THEN RAISE EXCEPTION 'normal_combat_invalid_location'; END IF;
  IF jsonb_typeof(v_save.state->'team') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_save.state->'team') NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'normal_combat_invalid_formation';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'base_item_id', base_item_id, 'slot', slot, 'rarity', rarity,
    'stats', stats, 'enchant_level', enchant_level, 'reroll_count', reroll_count
  ) ORDER BY id), '[]'::jsonb)
  INTO v_ledger FROM public.player_items WHERE player_id = p_player_id AND removed_at IS NULL;
  v_seed := 1 + floor(random() * 2147483646)::integer;
  INSERT INTO public.normal_combat_events(start_key, player_id, location, seed, state_revision, available_at)
  VALUES (p_start_key, p_player_id, p_location, v_seed, v_save.revision, now() + interval '12 seconds')
  RETURNING * INTO v_event;
  RETURN public.normal_combat_event_result(v_event, false) || jsonb_build_object(
    'needs_simulation', true, 'state', v_save.state, 'ledger_items', v_ledger
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.normal_combat_store_outcome(
  p_player_id uuid, p_start_key uuid, p_initial_units jsonb, p_reward_bonuses jsonb, p_outcome jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_event public.normal_combat_events%ROWTYPE;
  v_team_size integer;
  v_won_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('normal-combat:' || p_player_id::text, 0));
  SELECT * INTO v_event FROM public.normal_combat_events WHERE start_key = p_start_key FOR UPDATE;
  IF NOT FOUND OR v_event.player_id <> p_player_id THEN RAISE EXCEPTION 'normal_combat_not_found'; END IF;
  IF v_event.outcome IS NOT NULL THEN
    IF v_event.initial_units <> p_initial_units OR v_event.reward_bonuses <> p_reward_bonuses OR v_event.outcome <> p_outcome THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN public.normal_combat_event_result(v_event, true);
  END IF;
  IF jsonb_typeof(p_initial_units) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_initial_units) NOT BETWEEN 2 AND 6
    OR jsonb_typeof(p_reward_bonuses) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_outcome) IS DISTINCT FROM 'object'
    OR p_outcome->>'status' NOT IN ('cleared', 'failed')
    OR jsonb_typeof(p_outcome->'final_units') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_outcome->'final_units') <> jsonb_array_length(p_initial_units)
    OR jsonb_typeof(p_outcome->'won_hero_uids') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_outcome->'dead_hero_uids') IS DISTINCT FROM 'array'
    OR COALESCE((p_outcome->>'elapsed_ms')::integer, 0) NOT BETWEEN 0 AND 120000 THEN
    RAISE EXCEPTION 'normal_combat_invalid_outcome';
  END IF;
  SELECT count(*) INTO v_team_size FROM jsonb_array_elements(p_initial_units) unit WHERE unit->>'side' = 'hero';
  SELECT count(*) INTO v_won_count FROM jsonb_array_elements(p_outcome->'won_hero_uids');
  IF v_team_size NOT BETWEEN 1 AND 3 OR jsonb_array_length(p_initial_units) <> v_team_size * 2
    OR COALESCE((p_outcome->>'cleared_lanes')::integer, -1) <> v_won_count
    OR v_won_count > v_team_size THEN RAISE EXCEPTION 'normal_combat_invalid_outcome'; END IF;
  UPDATE public.normal_combat_events
  SET initial_units = p_initial_units, reward_bonuses = p_reward_bonuses, outcome = p_outcome
  WHERE start_key = p_start_key RETURNING * INTO v_event;
  RETURN public.normal_combat_event_result(v_event, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.normal_combat_advance_quests(
  p_quests jsonb, p_prefix text, p_amount bigint
)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE WHEN jsonb_typeof(p_quests) = 'array' THEN COALESCE(jsonb_agg(
    CASE WHEN quest->>'id' LIKE p_prefix || '%' AND COALESCE((quest->>'claimed')::boolean, false) = false
      THEN jsonb_set(quest, '{progress}', to_jsonb(LEAST(
        COALESCE((quest->>'target')::bigint, 9223372036854775807),
        COALESCE((quest->>'progress')::bigint, 0) + GREATEST(0, p_amount)
      ))) ELSE quest END ORDER BY ordinality
  ), '[]'::jsonb) ELSE p_quests END
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_quests) = 'array' THEN p_quests ELSE '[]'::jsonb END)
    WITH ORDINALITY AS quests(quest, ordinality)
$$;

CREATE OR REPLACE FUNCTION public.normal_combat_complete(
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
  v_gold_per_lane integer;
  v_xp_per_lane integer;
  v_gold bigint;
  v_account_xp bigint;
  v_total_xp bigint;
  v_account_level integer := 1;
  v_account_start bigint := 0;
  v_now_ms bigint := floor(extract(epoch FROM now()) * 1000);
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
  v_state := v_save.state;
  v_cleared := GREATEST(0, LEAST(3, COALESCE((v_event.outcome->>'cleared_lanes')::integer, 0)));
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_won FROM jsonb_array_elements_text(v_event.outcome->'won_hero_uids');
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_dead FROM jsonb_array_elements_text(v_event.outcome->'dead_hero_uids');
  v_gold_per_lane := round((5 + v_event.location) * (1 + LEAST(10, GREATEST(0, COALESCE((v_event.reward_bonuses->>'gold')::numeric, 0)))))::integer;
  v_xp_per_lane := round(GREATEST(1, round((4 + v_event.location * 1.2) * .55))
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
      IF v_uid = ANY(v_won) THEN
        v_level := GREATEST(1, LEAST(99, COALESCE((v_hero->>'level')::integer, 1)));
        v_remaining := GREATEST(0, COALESCE((v_hero->>'xp')::bigint, 0)) + v_xp_per_lane;
        WHILE v_level < 99 AND v_remaining >= public.hero_xp_needed(v_level) LOOP
          v_remaining := v_remaining - public.hero_xp_needed(v_level); v_level := v_level + 1;
        END LOOP;
        IF v_level >= 99 THEN v_remaining := 0; END IF;
        v_hero := jsonb_set(jsonb_set(v_hero, '{level}', to_jsonb(v_level)), '{xp}', to_jsonb(v_remaining));
      END IF;
      IF v_uid = ANY(v_dead) THEN v_hero := jsonb_set(v_hero, '{respawnAt}', to_jsonb(v_now_ms + 15000)); END IF;
      v_heroes := jsonb_set(v_heroes, ARRAY[v_index::text], v_hero);
    END LOOP;
  END IF;
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.normal_combat_advance_quests(v_state->'dailyQuests', 'kill-', v_cleared));
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'kill-', v_cleared));
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'gold-earned-', v_gold));
  IF COALESCE((v_event.outcome->>'all_cleared')::boolean, false)
    AND v_event.location = COALESCE((v_state->>'highestLocation')::integer, 1)
    AND v_event.location < 10 THEN
    v_state := jsonb_set(v_state, '{highestLocation}', to_jsonb(v_event.location + 1));
  END IF;
  v_state := jsonb_set(v_state, '{combatXpAt}', to_jsonb(v_now_ms));
  v_state := jsonb_set(v_state, '{lastSeen}', to_jsonb(v_now_ms));
  v_state := jsonb_set(v_state, '{boost,combatProgressSeconds}', '0'::jsonb);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING * INTO v_save;
  v_result := jsonb_build_object(
    'wave_id', v_event.id, 'start_key', v_event.start_key, 'revision', v_save.revision,
    'state', v_save.state, 'outcome', v_event.outcome,
    'rewards', jsonb_build_object('gold', v_gold, 'account_xp', v_account_xp,
      'hero_xp_per_winner', v_xp_per_lane, 'kills', v_cleared),
    'replayed', false
  );
  UPDATE public.normal_combat_events SET completed_at = now(), result = v_result
  WHERE start_key = p_start_key;
  INSERT INTO public.normal_combat_completion_events(idempotency_key, player_id, start_key, result)
  VALUES (p_idempotency_key, p_player_id, p_start_key, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_periodic_progression_legacy(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_event_result(public.normal_combat_events, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_prepare(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_advance_quests(jsonb, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.normal_combat_prepare(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.normal_combat_store_outcome(uuid, uuid, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid) TO service_role;
