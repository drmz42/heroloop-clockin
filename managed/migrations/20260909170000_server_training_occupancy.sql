-- Server-owned Training Camp occupancy. The forward migration preserves only
-- verifiable assignments and deliberately grants no XP for the migration gap.

CREATE TABLE public.training_assignment_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 0 AND 9),
  hero_uid text CHECK (hero_uid IS NULL OR char_length(hero_uid) BETWEEN 1 AND 100),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX training_assignment_events_player_created
  ON public.training_assignment_events(player_id, created_at DESC);

ALTER TABLE public.training_assignment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.training_assignment_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.canonical_training_uids(p_state jsonb, p_unlocked_slots integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uids jsonb := COALESCE(p_state#>'{trainingCamp,heroUids}', '[]'::jsonb);
  v_owned jsonb := COALESCE(p_state->'ownedHeroes', '[]'::jsonb);
  v_team jsonb := COALESCE(p_state->'team', '[]'::jsonb);
  v_account_level integer := GREATEST(1, LEAST(99, COALESCE((p_state->>'accountLevel')::integer, 1)));
  v_seen text[] := ARRAY[]::text[];
  v_result jsonb := '[]'::jsonb;
  v_uid text;
  v_hero jsonb;
  v_slot integer;
BEGIN
  FOR v_slot IN 0..9 LOOP
    v_uid := CASE WHEN v_slot < GREATEST(2, LEAST(10, p_unlocked_slots)) THEN v_uids->>v_slot ELSE NULL END;
    v_hero := NULL;
    IF v_uid IS NOT NULL AND NOT v_uid = ANY(v_seen) AND NOT v_team ? v_uid THEN
      SELECT hero INTO v_hero FROM jsonb_array_elements(v_owned) owned(hero)
      WHERE hero->>'uid' = v_uid
        AND GREATEST(1, LEAST(99, COALESCE((hero->>'level')::integer, 1))) < v_account_level
      LIMIT 1;
    END IF;
    IF v_hero IS NULL THEN
      v_result := v_result || 'null'::jsonb;
    ELSE
      v_seen := array_append(v_seen, v_uid);
      v_result := v_result || to_jsonb(v_uid);
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_training_state_at(
  p_state jsonb,
  p_cutoff timestamptz,
  p_unlocked_slots integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb := p_state;
  v_camp jsonb := COALESCE(p_state->'trainingCamp', '{}'::jsonb);
  v_uids jsonb;
  v_owned jsonb := COALESCE(p_state->'ownedHeroes', '[]'::jsonb);
  v_team jsonb := COALESCE(p_state->'team', '[]'::jsonb);
  v_queue jsonb := COALESCE(p_state#>'{trainingCamp,boostQueue}', '[]'::jsonb);
  v_next jsonb;
  v_now_ms bigint := FLOOR(EXTRACT(EPOCH FROM p_cutoff) * 1000);
  v_from_ms bigint;
  v_cursor bigint;
  v_segment_end bigint;
  v_reward_start bigint;
  v_multiplier integer;
  v_boost_ends bigint;
  v_active_key text;
  v_effective_seconds numeric := 0;
  v_account_level integer := GREATEST(1, LEAST(99, COALESCE((p_state->>'accountLevel')::integer, 1)));
  v_highest integer := GREATEST(1, LEAST(20, COALESCE((p_state->>'highestLocation')::integer, 1)));
  v_location integer := 1;
  v_unlock_levels integer[] := ARRAY[1,5,10,16,23,31,40,50,60,70,80,82,84,86,88,90,92,94,96,98];
  v_endgame_xp integer[] := ARRAY[9,10,11,11,12,13,13,14,15,15];
  v_xp_wave integer;
  v_xp_gain bigint;
  v_hero jsonb;
  v_uid text;
  v_level integer;
  v_remaining bigint;
  v_index integer;
BEGIN
  IF jsonb_typeof(v_owned) <> 'array' OR jsonb_typeof(v_team) <> 'array' OR jsonb_typeof(v_queue) <> 'array' THEN
    RAISE EXCEPTION 'invalid_save_state';
  END IF;
  v_uids := public.canonical_training_uids(v_state, p_unlocked_slots);
  v_from_ms := LEAST(v_now_ms, GREATEST(0, COALESCE((v_camp->>'lastTick')::bigint, v_now_ms)));
  v_cursor := v_from_ms;
  v_reward_start := GREATEST(v_from_ms, v_now_ms - 7 * 24 * 60 * 60 * 1000);
  v_multiplier := CASE WHEN COALESCE((v_camp->>'boostMultiplier')::integer, 1) IN (2,4)
    THEN (v_camp->>'boostMultiplier')::integer ELSE 1 END;
  v_boost_ends := GREATEST(0, COALESCE((v_camp->>'boostEndsAt')::bigint, 0));
  v_active_key := CASE WHEN v_camp->>'activeBoostKey' ~ '^(2|4)x-(1|4)h$' THEN v_camp->>'activeBoostKey' ELSE NULL END;

  WHILE v_cursor < v_now_ms LOOP
    IF v_multiplier > 1 AND v_boost_ends > v_cursor THEN
      v_segment_end := LEAST(v_now_ms, v_boost_ends);
      v_effective_seconds := v_effective_seconds
        + GREATEST(0, v_segment_end - GREATEST(v_cursor, v_reward_start))::numeric / 1000 * v_multiplier;
      v_cursor := v_segment_end;
      IF v_cursor < v_now_ms AND v_cursor >= v_boost_ends THEN
        v_active_key := NULL; v_multiplier := 1; v_boost_ends := 0;
      END IF;
    ELSIF jsonb_array_length(v_queue) > 0 THEN
      v_next := v_queue->0;
      v_queue := v_queue - 0;
      IF COALESCE((v_next->>'multiplier')::integer, 0) IN (2,4)
        AND COALESCE((v_next->>'durationMs')::bigint, 0) BETWEEN 1 AND 14400000
        AND v_next->>'key' ~ '^(2|4)x-(1|4)h$' THEN
        v_active_key := v_next->>'key';
        v_multiplier := (v_next->>'multiplier')::integer;
        v_boost_ends := v_cursor + (v_next->>'durationMs')::bigint;
      END IF;
    ELSE
      v_effective_seconds := v_effective_seconds
        + GREATEST(0, v_now_ms - GREATEST(v_cursor, v_reward_start))::numeric / 1000;
      v_cursor := v_now_ms;
    END IF;
  END LOOP;
  IF v_multiplier > 1 AND v_boost_ends <= v_now_ms THEN
    v_active_key := NULL; v_multiplier := 1; v_boost_ends := 0;
  END IF;

  FOR v_index IN 1..LEAST(20, v_highest) LOOP
    IF v_account_level >= v_unlock_levels[v_index] THEN v_location := v_index; END IF;
  END LOOP;
  v_xp_wave := CASE WHEN v_location > 10 THEN v_endgame_xp[v_location - 10]
    ELSE GREATEST(1, ROUND((4 + v_location * 1.2) * 0.55)::integer) END;
  v_xp_gain := FLOOR((v_xp_wave * 1.6 / 12) * v_effective_seconds);

  IF jsonb_array_length(v_owned) > 0 AND v_xp_gain > 0 THEN
    FOR v_index IN 0..jsonb_array_length(v_owned) - 1 LOOP
      v_hero := v_owned->v_index;
      v_uid := v_hero->>'uid';
      v_level := GREATEST(1, LEAST(99, COALESCE((v_hero->>'level')::integer, 1)));
      IF v_uids ? v_uid AND NOT v_team ? v_uid AND v_level < v_account_level THEN
        v_remaining := GREATEST(0, COALESCE((v_hero->>'xp')::bigint, 0)) + v_xp_gain;
        WHILE v_level < v_account_level AND v_remaining >= public.hero_xp_needed(v_level) LOOP
          v_remaining := v_remaining - public.hero_xp_needed(v_level);
          v_level := v_level + 1;
        END LOOP;
        IF v_level >= v_account_level THEN v_remaining := 0; END IF;
        v_hero := jsonb_set(jsonb_set(v_hero, '{level}', to_jsonb(v_level)), '{xp}', to_jsonb(v_remaining));
        v_owned := jsonb_set(v_owned, ARRAY[v_index::text], v_hero);
      END IF;
    END LOOP;
  END IF;

  v_camp := v_camp || jsonb_build_object(
    'heroUids', public.canonical_training_uids(jsonb_set(v_state, '{ownedHeroes}', v_owned), p_unlocked_slots),
    'unlockedSlots', GREATEST(2, LEAST(10, p_unlocked_slots)),
    'activeBoostKey', v_active_key,
    'boostMultiplier', v_multiplier,
    'boostEndsAt', v_boost_ends,
    'boostQueue', v_queue,
    'lastTick', v_now_ms
  );
  RETURN jsonb_set(jsonb_set(v_state, '{ownedHeroes}', v_owned), '{trainingCamp}', v_camp, true);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_training_assignment(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_slot_index integer,
  p_hero_uid text,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.training_assignment_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_player public.players%ROWTYPE;
  v_state jsonb;
  v_camp jsonb;
  v_uids jsonb;
  v_owned jsonb;
  v_event public.token_spend_events%ROWTYPE;
  v_applied jsonb;
  v_multiplier integer;
  v_hours integer;
  v_key text;
  v_duration bigint;
  v_now timestamptz := clock_timestamp();
  v_now_ms bigint := FLOOR(EXTRACT(EPOCH FROM v_now) * 1000);
  v_unlocked integer;
  v_count integer;
  v_penalty numeric;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_slot_index NOT BETWEEN 0 AND 9
    OR p_expected_revision IS NULL OR p_expected_revision < 1
    OR (p_hero_uid IS NOT NULL AND char_length(p_hero_uid) NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'invalid_training_assignment';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.training_assignment_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.slot_index <> p_slot_index
      OR v_existing.hero_uid IS DISTINCT FROM p_hero_uid OR v_existing.expected_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  SELECT * INTO v_player FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;

  SELECT LEAST(10, 2 + count(*))::integer INTO v_unlocked
  FROM public.token_spend_events WHERE player_id = p_player_id AND action_kind = 'training-slot';
  IF p_slot_index >= v_unlocked THEN RAISE EXCEPTION 'training_slot_locked'; END IF;

  v_state := public.settle_training_state_at(v_save.state, v_now, v_unlocked);
  v_camp := v_state->'trainingCamp';
  v_applied := COALESCE(v_camp->'serverAppliedPurchaseIds', '[]'::jsonb);
  IF jsonb_typeof(v_applied) <> 'array' THEN v_applied := '[]'::jsonb; END IF;
  FOR v_event IN
    SELECT * FROM public.token_spend_events
    WHERE player_id = p_player_id AND action_kind LIKE 'training-%'
      AND NOT v_applied ? idempotency_key::text
    ORDER BY created_at, idempotency_key
  LOOP
    IF v_event.action_kind ~ '^training-boost-(2|4)x-(1|4)h$' THEN
      v_multiplier := split_part(split_part(v_event.action_kind, '-', 3), 'x', 1)::integer;
      v_hours := trim(trailing 'h' from split_part(v_event.action_kind, '-', 4))::integer;
      v_key := v_multiplier || 'x-' || v_hours || 'h';
      v_duration := v_hours::bigint * 60 * 60 * 1000;
      IF COALESCE((v_camp->>'boostMultiplier')::integer, 1) <= 1 OR COALESCE((v_camp->>'boostEndsAt')::bigint, 0) <= v_now_ms THEN
        v_camp := v_camp || jsonb_build_object('activeBoostKey',v_key,'boostMultiplier',v_multiplier,'boostEndsAt',v_now_ms+v_duration);
      ELSIF v_camp->>'activeBoostKey' = v_key THEN
        v_camp := jsonb_set(v_camp, '{boostEndsAt}', to_jsonb((v_camp->>'boostEndsAt')::bigint + v_duration), true);
      ELSE
        v_camp := jsonb_set(v_camp, '{boostQueue}', COALESCE(v_camp->'boostQueue','[]'::jsonb)
          || jsonb_build_array(jsonb_build_object('key',v_key,'multiplier',v_multiplier,'durationMs',v_duration)), true);
      END IF;
    END IF;
    v_applied := v_applied || to_jsonb(v_event.idempotency_key::text);
    IF jsonb_array_length(v_applied) > 200 THEN v_applied := v_applied - 0; END IF;
  END LOOP;
  v_camp := jsonb_set(v_camp, '{serverAppliedPurchaseIds}', v_applied, true);
  v_state := jsonb_set(v_state, '{trainingCamp}', v_camp, true);
  v_uids := public.canonical_training_uids(v_state, v_unlocked);

  IF p_hero_uid IS NOT NULL THEN
    SELECT hero INTO v_owned FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes','[]'::jsonb)) owned(hero)
    WHERE hero->>'uid' = p_hero_uid LIMIT 1;
    IF v_owned IS NULL THEN RAISE EXCEPTION 'hero_not_found'; END IF;
    IF COALESCE(v_state->'team','[]'::jsonb) ? p_hero_uid THEN RAISE EXCEPTION 'hero_in_team'; END IF;
    IF GREATEST(1, COALESCE((v_owned->>'level')::integer, 1)) >= GREATEST(1, COALESCE((v_state->>'accountLevel')::integer, 1)) THEN
      RAISE EXCEPTION 'hero_level_capped';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_uids) WITH ORDINALITY entry(uid, ordinal)
      WHERE uid #>> '{}' = p_hero_uid AND ordinal - 1 <> p_slot_index) THEN
      RAISE EXCEPTION 'hero_already_training';
    END IF;
  END IF;

  v_uids := jsonb_set(v_uids, ARRAY[p_slot_index::text], COALESCE(to_jsonb(p_hero_uid), 'null'::jsonb), false);
  v_camp := jsonb_set(v_camp, '{heroUids}', v_uids, true);
  v_state := jsonb_set(v_state, '{trainingCamp}', v_camp, true);
  v_count := (SELECT count(*) FROM jsonb_array_elements(v_uids) entry(uid) WHERE uid <> 'null'::jsonb);
  v_penalty := CASE v_count WHEN 0 THEN 0 WHEN 1 THEN 0.1 WHEN 2 THEN 0.25 WHEN 3 THEN 0.5 WHEN 4 THEN 0.75 ELSE 0.9 END;

  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = v_now
  WHERE player_id = p_player_id AND revision = p_expected_revision
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'state_conflict'; END IF;
  UPDATE public.players SET
    training_hero_count = v_count,
    combat_power = GREATEST(0, combat_power),
    power = FLOOR(GREATEST(0, combat_power) * (1 - v_penalty))::bigint,
    updated_at = v_now
  WHERE player_id = p_player_id
  RETURNING * INTO v_player;

  v_result := jsonb_build_object(
    'slot_index', p_slot_index, 'hero_uid', p_hero_uid, 'hero_uids', v_uids,
    'owned_heroes', v_state->'ownedHeroes', 'training_camp', v_camp,
    'training_hero_count', v_count, 'penalty', v_penalty,
    'power', v_player.power, 'combat_power', v_player.combat_power,
    'revision', v_revision
  );
  INSERT INTO public.training_assignment_events(idempotency_key,player_id,slot_index,hero_uid,expected_revision,result)
  VALUES(p_idempotency_key,p_player_id,p_slot_index,p_hero_uid,p_expected_revision,v_result);
  RETURN v_result;
END;
$$;

-- Conservative one-time adoption: preserve only canonical assignments, derive
-- unlocked slots from server spend history, and start the auditable XP clock at
-- database time without crediting an unverifiable pre-migration interval.
WITH canonical AS (
  SELECT save.player_id,
    public.canonical_training_uids(save.state, LEAST(10, 2 + count(spend.*))::integer) AS hero_uids,
    LEAST(10, 2 + count(spend.*))::integer AS unlocked_slots,
    FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS cutoff_ms
  FROM public.player_saves save
  LEFT JOIN public.token_spend_events spend ON spend.player_id = save.player_id AND spend.action_kind = 'training-slot'
  GROUP BY save.player_id, save.state
), updated AS (
  UPDATE public.player_saves save SET
    state = jsonb_set(save.state, '{trainingCamp}', COALESCE(save.state->'trainingCamp','{}'::jsonb) || jsonb_build_object(
      'heroUids', canonical.hero_uids, 'unlockedSlots', canonical.unlocked_slots, 'lastTick', canonical.cutoff_ms
    ), true),
    revision = save.revision + 1,
    updated_at = clock_timestamp()
  FROM canonical WHERE canonical.player_id = save.player_id
  RETURNING save.player_id, canonical.hero_uids
)
UPDATE public.players player SET
  training_hero_count = counts.training_count,
  power = FLOOR(GREATEST(0, player.combat_power) * (CASE counts.training_count
    WHEN 0 THEN 1 WHEN 1 THEN 0.9 WHEN 2 THEN 0.75 WHEN 3 THEN 0.5 WHEN 4 THEN 0.25 ELSE 0.1 END))::bigint,
  updated_at = clock_timestamp()
FROM (
  SELECT updated.player_id, count(*) FILTER (WHERE uid <> 'null'::jsonb)::integer AS training_count
  FROM updated, LATERAL jsonb_array_elements(updated.hero_uids) entry(uid)
  GROUP BY updated.player_id
) counts
WHERE player.player_id = counts.player_id;

REVOKE ALL ON FUNCTION public.canonical_training_uids(jsonb,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_training_state_at(jsonb,timestamptz,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_training_assignment(uuid,uuid,integer,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_training_assignment(uuid,uuid,integer,text,bigint) TO service_role;

COMMENT ON FUNCTION public.settle_training_assignment(uuid,uuid,integer,text,bigint) IS
  'Atomically settles old Training XP, changes one server-owned slot, and refreshes reward Power.';
