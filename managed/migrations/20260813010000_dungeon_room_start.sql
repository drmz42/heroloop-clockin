ALTER TABLE public.dungeon_encounters
  ADD COLUMN IF NOT EXISTS run_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS room_state jsonb,
  ADD COLUMN IF NOT EXISTS room_started_at timestamptz;

ALTER TABLE public.dungeon_encounters
  ADD CONSTRAINT dungeon_encounters_run_state_object
    CHECK (jsonb_typeof(run_state) = 'object'),
  ADD CONSTRAINT dungeon_encounters_room_state_object
    CHECK (room_state IS NULL OR jsonb_typeof(room_state) = 'object');

ALTER TABLE public.dungeon_events DROP CONSTRAINT dungeon_events_action_check;
ALTER TABLE public.dungeon_events ADD CONSTRAINT dungeon_events_action_check
  CHECK (action IN ('start', 'room_start', 'abandon'));

CREATE OR REPLACE FUNCTION public.dungeon_initial_run_state(p_roster jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'heroes', COALESCE(jsonb_agg(jsonb_build_object(
      'position', (hero->>'position')::integer,
      'uid', hero->>'uid',
      'hero_id', hero->>'hero_id',
      'max_hp', (hero->'stats'->>'hp')::bigint,
      'current_hp', (hero->'stats'->>'hp')::bigint,
      'alive', true
    ) ORDER BY (hero->>'position')::integer), '[]'::jsonb),
    'rooms_cleared', 0
  )
  FROM jsonb_array_elements(p_roster) AS roster(hero)
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_one_enemies(p_depth integer, p_team_size integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_agg(jsonb_build_object(
    'unit_id', 'guard-' || lane,
    'lane', lane,
    'max_hp', CASE p_depth WHEN 1 THEN 618 WHEN 2 THEN 2372 WHEN 3 THEN 6759 END,
    'current_hp', CASE p_depth WHEN 1 THEN 618 WHEN 2 THEN 2372 WHEN 3 THEN 6759 END,
    'atk', CASE p_depth WHEN 1 THEN 58 WHEN 2 THEN 214 WHEN 3 THEN 585 END,
    'def', CASE p_depth WHEN 1 THEN 19 WHEN 2 THEN 78 WHEN 3 THEN 272 END,
    'speed', CASE p_depth WHEN 1 THEN 99.630 WHEN 2 THEN 102.888 WHEN 3 THEN 102.888 END,
    'alive', true
  ) ORDER BY lane)
  FROM generate_series(1, p_team_size) AS lanes(lane)
$$;

CREATE OR REPLACE FUNCTION public.dungeon_status(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_week date := public.dungeon_week_start(v_now);
  v_account_level integer;
  v_attempt_week date;
  v_attempts integer;
  v_max_depth integer;
  v_active public.dungeon_encounters%ROWTYPE;
  v_boss public.boss_encounters%ROWTYPE;
  v_active_json jsonb := NULL;
BEGIN
  SELECT LEAST(99, GREATEST(1, COALESCE((state->>'accountLevel')::integer, 1))) INTO v_account_level
  FROM public.player_saves WHERE player_id = p_player_id;
  IF v_account_level IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT attempt_week, attempts_remaining, max_depth_cleared INTO v_attempt_week, v_attempts, v_max_depth
  FROM public.dungeon_player_state WHERE player_id = p_player_id;
  v_attempts := CASE WHEN v_attempt_week = v_week THEN COALESCE(v_attempts, 3) ELSE 3 END;
  v_max_depth := COALESCE(v_max_depth, 0);
  SELECT * INTO v_active FROM public.dungeon_encounters
  WHERE player_id = p_player_id AND status = 'active' ORDER BY started_at DESC LIMIT 1;
  IF FOUND THEN
    v_active_json := jsonb_build_object(
      'type', 'dungeon', 'encounter_id', v_active.id, 'depth', v_active.depth,
      'room', v_active.room, 'revision', v_active.revision, 'balance_version', v_active.balance_version,
      'seed', v_active.seed, 'roster_snapshot', v_active.roster_snapshot,
      'run_state', v_active.run_state, 'room_state', v_active.room_state,
      'room_started_at', v_active.room_started_at, 'started_at', v_active.started_at);
  ELSE
    SELECT * INTO v_boss FROM public.boss_encounters
    WHERE player_id = p_player_id AND status = 'active' ORDER BY started_at DESC LIMIT 1;
    IF FOUND THEN v_active_json := jsonb_build_object('type', 'boss_hunt', 'encounter_id', v_boss.id, 'status', v_boss.status); END IF;
  END IF;
  RETURN jsonb_build_object(
    'attempts_remaining', v_attempts, 'attempts_max', 3, 'week_start', v_week,
    'next_reset_at', public.dungeon_next_reset(v_now), 'account_level', v_account_level,
    'max_depth_cleared', v_max_depth, 'unlocks', public.dungeon_unlocks(v_account_level, v_max_depth),
    'active_encounter', v_active_json);
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_start(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb := jsonb_build_object(
    'encounter_id', p_encounter_id,
    'expected_revision', p_expected_revision
  );
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_run_state jsonb;
  v_room_state jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'room_start' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'dungeon_invalid_revision';
  END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id = p_encounter_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status <> 'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision <> p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room <> 1 THEN RAISE EXCEPTION 'dungeon_room_not_available'; END IF;
  IF v_encounter.room_state IS NOT NULL THEN RAISE EXCEPTION 'dungeon_room_already_started'; END IF;

  v_run_state := CASE WHEN v_encounter.run_state = '{}'::jsonb
    THEN public.dungeon_initial_run_state(v_encounter.roster_snapshot)
    ELSE v_encounter.run_state END;
  IF jsonb_typeof(v_run_state->'heroes') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_run_state->'heroes') IS DISTINCT FROM jsonb_array_length(v_encounter.roster_snapshot) THEN
    RAISE EXCEPTION 'dungeon_run_state_invalid';
  END IF;
  v_room_state := jsonb_build_object(
    'room', 1,
    'kind', 'normal_guards',
    'status', 'ready',
    'sequence', 0,
    'max_seconds', 120,
    'combat_balance_version', '2026.08.13-dungeon-room-v1',
    'heroes', v_run_state->'heroes',
    'enemies', public.dungeon_room_one_enemies(v_encounter.depth, jsonb_array_length(v_run_state->'heroes'))
  );
  UPDATE public.dungeon_encounters
  SET run_state = v_run_state,
      room_state = v_room_state,
      room_started_at = now(),
      revision = revision + 1
  WHERE id = v_encounter.id
  RETURNING * INTO v_encounter;
  v_result := jsonb_build_object(
    'encounter_id', v_encounter.id,
    'room', v_encounter.room,
    'revision', v_encounter.revision,
    'run_state', v_encounter.run_state,
    'room_state', v_encounter.room_state,
    'room_started_at', v_encounter.room_started_at
  );
  INSERT INTO public.dungeon_events(idempotency_key, player_id, encounter_id, action, request, result)
  VALUES (p_idempotency_key, p_player_id, v_encounter.id, 'room_start', v_request, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_initial_run_state(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_one_enemies(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_start(uuid, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_start(uuid, uuid, bigint, uuid) TO service_role;
