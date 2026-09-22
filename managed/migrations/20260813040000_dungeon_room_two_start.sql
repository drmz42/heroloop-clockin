CREATE OR REPLACE FUNCTION public.dungeon_room_two_enemies(p_depth integer, p_heroes jsonb, p_modifier text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'unit_id', 'elite-guard-' || (hero->>'position'),
    'lane', (hero->>'position')::integer,
    'max_hp', CASE p_depth WHEN 1 THEN 649 WHEN 2 THEN 2491 WHEN 3 THEN 7097 END,
    'current_hp', CASE p_depth WHEN 1 THEN 649 WHEN 2 THEN 2491 WHEN 3 THEN 7097 END,
    'atk', CASE p_depth WHEN 1 THEN 61 WHEN 2 THEN 225 WHEN 3 THEN 614 END,
    'def', ROUND((CASE p_depth WHEN 1 THEN 20 WHEN 2 THEN 82 WHEN 3 THEN 286 END)
      * CASE WHEN p_modifier = 'stone_skin' THEN 1.20 ELSE 1 END),
    'speed', CASE p_depth WHEN 1 THEN 99.630 WHEN 2 THEN 102.888 WHEN 3 THEN 102.888 END,
    'attack_speed_bonus', 0,
    'shield', 0,
    'alive', true,
    'modifier_triggered', false
  ) ORDER BY (hero->>'position')::integer), '[]'::jsonb)
  FROM jsonb_array_elements(p_heroes) AS heroes(hero)
  WHERE COALESCE((hero->>'alive')::boolean, false)
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
  v_modifier text;
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
  IF v_encounter.room NOT IN (1, 2) THEN RAISE EXCEPTION 'dungeon_room_not_available'; END IF;
  IF v_encounter.room_state IS NOT NULL THEN RAISE EXCEPTION 'dungeon_room_already_started'; END IF;

  v_run_state := CASE WHEN v_encounter.room = 1 AND v_encounter.run_state = '{}'::jsonb
    THEN public.dungeon_initial_run_state(v_encounter.roster_snapshot)
    ELSE v_encounter.run_state END;
  IF jsonb_typeof(v_run_state->'heroes') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_run_state->'heroes') IS DISTINCT FROM jsonb_array_length(v_encounter.roster_snapshot)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_run_state->'heroes') AS heroes(hero)
      WHERE COALESCE((hero->>'alive')::boolean, false)) THEN
    RAISE EXCEPTION 'dungeon_run_state_invalid';
  END IF;

  IF v_encounter.room = 1 THEN
    v_room_state := jsonb_build_object(
      'room', 1, 'kind', 'normal_guards', 'status', 'ready', 'sequence', 0, 'max_seconds', 120,
      'combat_balance_version', '2026.08.13-dungeon-room-v1',
      'heroes', v_run_state->'heroes',
      'enemies', public.dungeon_room_one_enemies(v_encounter.depth, jsonb_array_length(v_run_state->'heroes'))
    );
  ELSE
    IF COALESCE((v_run_state->>'rooms_cleared')::integer, 0) <> 1 THEN
      RAISE EXCEPTION 'dungeon_room_not_available';
    END IF;
    v_modifier := CASE mod(mod(hashtextextended(v_encounter.seed::text || ':room2:modifier', 0), 5) + 5, 5)
      WHEN 0 THEN 'stone_skin'
      WHEN 1 THEN 'blood_oath'
      WHEN 2 THEN 'bound_souls'
      WHEN 3 THEN 'mark_of_the_abyss'
      ELSE 'last_fury'
    END;
    v_room_state := jsonb_build_object(
      'room', 2, 'kind', 'elite_guards', 'status', 'ready', 'sequence', 0, 'max_seconds', 120,
      'combat_balance_version', '2026.08.13-dungeon-room-v1',
      'modifier', v_modifier,
      'modifier_state', jsonb_build_object('trigger_count', 0, 'next_mark_ms',
        CASE WHEN v_modifier = 'mark_of_the_abyss' THEN 12000 ELSE NULL END),
      'heroes', v_run_state->'heroes',
      'enemies', public.dungeon_room_two_enemies(v_encounter.depth, v_run_state->'heroes', v_modifier)
    );
  END IF;

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

REVOKE ALL ON FUNCTION public.dungeon_room_two_enemies(integer, jsonb, text) FROM PUBLIC, anon, authenticated;
