ALTER TABLE public.boss_encounters
  ADD COLUMN IF NOT EXISTS dungeon_encounter_id uuid REFERENCES public.dungeon_encounters(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS boss_encounters_dungeon_encounter_idx
  ON public.boss_encounters(dungeon_encounter_id) WHERE dungeon_encounter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.boss_claim_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  boss_encounter_id uuid NOT NULL REFERENCES public.boss_encounters(id) ON DELETE CASCADE,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS boss_claim_events_player_created_idx
  ON public.boss_claim_events(player_id, created_at DESC);

ALTER TABLE public.boss_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.boss_claim_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.advance_boss_quests(p_quests jsonb, p_milestone boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(
    CASE WHEN COALESCE((quest->>'claimed')::boolean, false) = false
      AND ((quest->>'id') LIKE 'boss-%' OR quest->>'chain' = 'boss')
    THEN jsonb_set(quest, '{progress}', to_jsonb(CASE WHEN p_milestone
      THEN COALESCE((quest->>'progress')::integer, 0) + 1
      ELSE LEAST(COALESCE((quest->>'target')::integer, 0), COALESCE((quest->>'progress')::integer, 0) + 1)
    END), true) ELSE quest END ORDER BY ordinal
  ), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_quests) = 'array' THEN p_quests ELSE '[]'::jsonb END)
    WITH ORDINALITY entries(quest, ordinal)
$$;

CREATE OR REPLACE FUNCTION public.summon_boss(p_player_id uuid, p_location integer, p_idempotency_key uuid)
RETURNS TABLE(encounter_id uuid, remaining_keys integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_boss uuid; v_dungeon uuid; v_keys integer; v_depth integer;
  v_save public.player_saves%ROWTYPE; v_snapshot jsonb; v_run_state jsonb; v_seed bigint;
  v_resource jsonb; v_existing public.resource_transactions%ROWTYPE;
  v_hash text := encode(extensions.digest(jsonb_build_object('location', GREATEST(1, p_location))::text, 'sha256'), 'hex');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  SELECT * INTO v_existing FROM public.resource_transactions
  WHERE player_id = p_player_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.action <> 'boss_summon' OR v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'resource_idempotency_conflict';
    END IF;
    RETURN QUERY SELECT (v_existing.result->>'encounter_id')::uuid, (v_existing.result->>'remaining_keys')::integer;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.dungeon_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.boss_encounters WHERE player_id = p_player_id AND status = 'active') THEN
    RAISE EXCEPTION 'active_encounter_exists';
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_snapshot := public.dungeon_roster_snapshot(p_player_id, v_save.state);
  v_run_state := jsonb_set(public.dungeon_initial_run_state(v_snapshot), '{rooms_cleared}', '3'::jsonb, true);
  v_depth := CASE WHEN GREATEST(1, p_location) <= 4 THEN 1 WHEN GREATEST(1, p_location) <= 7 THEN 2 ELSE 3 END;
  v_seed := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))::bit(64)::bigint);
  v_resource := public.apply_resource_entries(p_player_id, p_idempotency_key, 'boss_summon', v_hash,
    '[{"resource_id":"boss_key","delta":"-1","source_key":"boss_key_spend"}]'::jsonb, v_save.revision + 1);
  v_keys := (v_resource#>>'{balances,boss_key}')::integer;
  INSERT INTO public.boss_encounters(player_id, location_id) VALUES (p_player_id, GREATEST(1, p_location)) RETURNING id INTO v_boss;
  INSERT INTO public.dungeon_encounters(player_id, depth, room, balance_version, seed, roster_snapshot, run_state)
  VALUES (p_player_id, v_depth, 4, '2026.08.24-boss-hunt-v1', v_seed, v_snapshot, v_run_state) RETURNING id INTO v_dungeon;
  UPDATE public.boss_encounters SET dungeon_encounter_id = v_dungeon WHERE id = v_boss;
  UPDATE public.players SET boss_keys = v_keys, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = jsonb_set(state, '{bossKeys}', to_jsonb(v_keys), true),
    revision = revision + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.resource_transactions SET result = result || jsonb_build_object(
    'encounter_id', v_boss, 'dungeon_encounter_id', v_dungeon, 'remaining_keys', v_keys)
  WHERE player_id = p_player_id AND idempotency_key = p_idempotency_key;
  RETURN QUERY SELECT v_boss, v_keys;
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_status(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now timestamptz := now(); v_week date := public.dungeon_week_start(v_now);
  v_account_level integer; v_attempt_week date; v_attempts integer; v_max_depth integer;
  v_active public.dungeon_encounters%ROWTYPE; v_boss public.boss_encounters%ROWTYPE; v_active_json jsonb := NULL;
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
    SELECT * INTO v_boss FROM public.boss_encounters
    WHERE player_id = p_player_id AND dungeon_encounter_id = v_active.id AND status = 'active' LIMIT 1;
    v_active_json := jsonb_build_object(
      'type', CASE WHEN FOUND THEN 'boss_hunt' ELSE 'dungeon' END,
      'encounter_id', v_active.id, 'boss_encounter_id', CASE WHEN FOUND THEN v_boss.id ELSE NULL END,
      'depth', v_active.depth, 'room', v_active.room, 'revision', v_active.revision,
      'balance_version', v_active.balance_version, 'seed', v_active.seed,
      'roster_snapshot', v_active.roster_snapshot, 'run_state', v_active.run_state,
      'room_state', v_active.room_state, 'room_started_at', v_active.room_started_at, 'started_at', v_active.started_at);
  ELSE
    SELECT * INTO v_boss FROM public.boss_encounters
    WHERE player_id = p_player_id AND status = 'active' ORDER BY started_at DESC LIMIT 1;
    IF FOUND THEN v_active_json := jsonb_build_object(
      'type', 'boss_hunt', 'boss_encounter_id', v_boss.id, 'legacy_unresumable', v_boss.dungeon_encounter_id IS NULL);
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'attempts_remaining', v_attempts, 'attempts_max', 3, 'week_start', v_week,
    'next_reset_at', public.dungeon_next_reset(v_now), 'account_level', v_account_level,
    'max_depth_cleared', v_max_depth, 'unlocks', public.dungeon_unlocks(v_account_level, v_max_depth),
    'active_encounter', v_active_json);
END;
$$;

CREATE OR REPLACE FUNCTION public.boss_claim(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.boss_claim_events%ROWTYPE; v_boss public.boss_encounters%ROWTYPE;
  v_encounter public.dungeon_encounters%ROWTYPE; v_save public.player_saves%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id', p_encounter_id, 'expected_revision', p_expected_revision);
  v_state jsonb; v_chests jsonb; v_chest jsonb; v_result jsonb; v_revision bigint;
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  v_day text := to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'); v_last_day text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.boss_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id = p_encounter_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_encounter_not_found'; END IF;
  SELECT * INTO v_boss FROM public.boss_encounters
  WHERE player_id = p_player_id AND dungeon_encounter_id = v_encounter.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_encounter_not_found'; END IF;
  IF v_boss.status <> 'active' OR v_encounter.status <> 'active' THEN RAISE EXCEPTION 'boss_encounter_not_active'; END IF;
  IF v_encounter.revision <> p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room <> 4 OR v_encounter.room_state->>'kind' <> 'shared_boss'
    OR v_encounter.room_state->>'status' <> 'reward_locked' THEN RAISE EXCEPTION 'boss_reward_not_ready'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_state := v_save.state; v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' OR jsonb_array_length(v_chests) >= 500 THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;
  v_last_day := to_char(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms), true);
  END IF;
  IF COALESCE((v_state->>'chestsOpenedToday')::integer, 0) >= 1000 THEN RAISE EXCEPTION 'daily_chest_limit_reached'; END IF;
  v_chest := jsonb_build_object('id', 'boss-' || v_boss.id::text, 'stage', v_boss.location_id, 'boss', true);
  v_state := jsonb_set(v_state, '{chests}', v_chests || jsonb_build_array(v_chest), true);
  v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + 1), true);
  v_state := jsonb_set(v_state, '{totalBossKills}', to_jsonb(COALESCE((v_state->>'totalBossKills')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{session,bossKills}', to_jsonb(COALESCE((v_state#>>'{session,bossKills}')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.advance_boss_quests(v_state->'dailyQuests', false), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.advance_boss_quests(v_state->'milestoneQuests', true), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET boss_kills = COALESCE(boss_kills, 0) + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.boss_encounters SET status = 'claimed', completed_at = now() WHERE id = v_boss.id;
  UPDATE public.dungeon_encounters SET status = 'completed', revision = revision + 1, completed_at = now()
  WHERE id = v_encounter.id RETURNING * INTO v_encounter;
  v_result := jsonb_build_object('encounter_id', v_encounter.id, 'boss_encounter_id', v_boss.id,
    'status', 'completed', 'revision', v_encounter.revision, 'boss_chest', v_chest,
    'state', v_state, 'save_revision', v_revision, 'reward_settled', true);
  INSERT INTO public.boss_claim_events(idempotency_key, player_id, boss_encounter_id, request, result)
  VALUES (p_idempotency_key, p_player_id, v_boss.id, v_request, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_boss_hunt_terminal_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status IN ('failed', 'abandoned') THEN
    UPDATE public.boss_encounters SET status = 'lost', completed_at = COALESCE(NEW.completed_at, now())
    WHERE dungeon_encounter_id = NEW.id AND status = 'active';
  ELSIF OLD.status = 'active' AND NEW.status = 'completed' AND OLD.room_state->>'status' = 'reward_locked'
    AND EXISTS (SELECT 1 FROM public.boss_encounters WHERE dungeon_encounter_id = NEW.id AND status = 'active') THEN
    RAISE EXCEPTION 'boss_claim_required';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dungeon_sync_boss_hunt_terminal_state ON public.dungeon_encounters;
CREATE TRIGGER dungeon_sync_boss_hunt_terminal_state BEFORE UPDATE OF status ON public.dungeon_encounters
FOR EACH ROW EXECUTE FUNCTION public.sync_boss_hunt_terminal_state();

REVOKE ALL ON FUNCTION public.advance_boss_quests(jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.summon_boss(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.boss_claim(uuid, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_boss_hunt_terminal_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.summon_boss(uuid, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.boss_claim(uuid, uuid, bigint, uuid) TO service_role;
