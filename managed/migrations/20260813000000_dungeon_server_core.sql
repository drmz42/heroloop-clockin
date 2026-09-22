CREATE TABLE IF NOT EXISTS public.dungeon_player_state (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  attempt_week date NOT NULL,
  attempts_remaining smallint NOT NULL DEFAULT 3 CHECK (attempts_remaining BETWEEN 0 AND 3),
  max_depth_cleared smallint NOT NULL DEFAULT 0 CHECK (max_depth_cleared BETWEEN 0 AND 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dungeon_encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  depth smallint NOT NULL CHECK (depth BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'abandoned', 'failed', 'completed')),
  room smallint NOT NULL DEFAULT 1 CHECK (room BETWEEN 1 AND 4),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  balance_version text NOT NULL CHECK (char_length(balance_version) BETWEEN 1 AND 80),
  seed bigint NOT NULL,
  roster_snapshot jsonb NOT NULL CHECK (jsonb_typeof(roster_snapshot) = 'array' AND jsonb_array_length(roster_snapshot) BETWEEN 1 AND 3),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS dungeon_encounters_one_active_per_player
  ON public.dungeon_encounters(player_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS dungeon_encounters_player_started
  ON public.dungeon_encounters(player_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.dungeon_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES public.dungeon_encounters(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('start', 'abandon')),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dungeon_events_player_created
  ON public.dungeon_events(player_id, created_at DESC);

ALTER TABLE public.dungeon_player_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dungeon_encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dungeon_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dungeon_player_state, public.dungeon_encounters, public.dungeon_events
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.dungeon_week_start(p_at timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT date_trunc('week', p_at AT TIME ZONE 'UTC')::date
$$;

CREATE OR REPLACE FUNCTION public.dungeon_next_reset(p_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT (date_trunc('week', p_at AT TIME ZONE 'UTC') + interval '7 days') AT TIME ZONE 'UTC'
$$;

CREATE OR REPLACE FUNCTION public.dungeon_unlocks(p_account_level integer, p_max_depth_cleared integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'depth_1', p_account_level >= 30,
    'depth_2', p_account_level >= 55 AND p_max_depth_cleared >= 1,
    'depth_3', p_account_level >= 80 AND p_max_depth_cleared >= 2
  )
$$;

CREATE OR REPLACE FUNCTION public.dungeon_star_multiplier(p_stars integer)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT 1::numeric
    + LEAST(5, GREATEST(0, p_stars)) * 0.22
    + LEAST(5, GREATEST(0, p_stars - 5)) * 0.15
    + LEAST(5, GREATEST(0, p_stars - 10)) * 0.12
    + LEAST(5, GREATEST(0, p_stars - 15)) * 0.10
$$;

CREATE OR REPLACE FUNCTION public.dungeon_roster_snapshot(p_player_id uuid, p_state jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_team jsonb := COALESCE(p_state->'team', '[]'::jsonb);
  v_owned jsonb := COALESCE(p_state->'ownedHeroes', '[]'::jsonb);
  v_snapshot jsonb := '[]'::jsonb;
  v_team_entry jsonb;
  v_hero jsonb;
  v_equipped_map jsonb;
  v_equipment jsonb;
  v_equipment_entry record;
  v_item public.player_items%ROWTYPE;
  v_stat jsonb;
  v_seen_heroes text[] := ARRAY[]::text[];
  v_seen_items uuid[] := ARRAY[]::uuid[];
  v_uid text;
  v_hero_id text;
  v_class text;
  v_rarity text;
  v_item_class text;
  v_level integer;
  v_stars integer;
  v_base_hp numeric;
  v_base_atk numeric;
  v_base_def numeric;
  v_base_speed numeric;
  v_rarity_scale numeric;
  v_star_scale numeric;
  v_item_hp numeric;
  v_item_atk numeric;
  v_item_def numeric;
  v_item_attack_speed numeric;
  v_item_count integer;
  v_set_rarity text;
  v_set_multiplier numeric;
  v_enchant_multiplier numeric;
  v_stat_value numeric;
  v_hp bigint;
  v_atk bigint;
  v_def bigint;
  v_power numeric;
BEGIN
  IF jsonb_typeof(v_team) <> 'array' OR jsonb_array_length(v_team) NOT BETWEEN 1 AND 3
    OR jsonb_typeof(v_owned) <> 'array' THEN
    RAISE EXCEPTION 'dungeon_invalid_formation';
  END IF;

  FOR v_team_entry IN SELECT value FROM jsonb_array_elements(v_team) LOOP
    IF jsonb_typeof(v_team_entry) <> 'string' THEN RAISE EXCEPTION 'dungeon_invalid_formation'; END IF;
    v_uid := v_team_entry #>> '{}';
    IF char_length(v_uid) NOT BETWEEN 1 AND 100 OR v_uid = ANY(v_seen_heroes) THEN
      RAISE EXCEPTION 'dungeon_invalid_formation';
    END IF;
    v_seen_heroes := array_append(v_seen_heroes, v_uid);

    SELECT value INTO v_hero
    FROM jsonb_array_elements(v_owned)
    WHERE value->>'uid' = v_uid
    LIMIT 1;
    IF v_hero IS NULL THEN RAISE EXCEPTION 'dungeon_invalid_formation'; END IF;

    v_hero_id := COALESCE(v_hero->>'heroId', '');
    IF v_hero_id !~ '^(shepherd|assassin|knight|druid|archer)-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$'
      OR COALESCE(v_hero->>'level', '') !~ '^[0-9]{1,3}$'
      OR COALESCE(v_hero->>'stars', '') !~ '^[0-9]{1,2}$' THEN
      RAISE EXCEPTION 'dungeon_invalid_formation';
    END IF;
    v_level := (v_hero->>'level')::integer;
    v_stars := (v_hero->>'stars')::integer;
    IF v_level NOT BETWEEN 1 AND 99 OR v_stars NOT BETWEEN 0 AND 20 THEN
      RAISE EXCEPTION 'dungeon_invalid_formation';
    END IF;

    v_class := split_part(v_hero_id, '-', 1);
    v_rarity := split_part(v_hero_id, '-', 2);
    SELECT hp, atk, def, speed INTO v_base_hp, v_base_atk, v_base_def, v_base_speed
    FROM (VALUES
      ('shepherd', 360::numeric, 72::numeric, 14::numeric, 108::numeric),
      ('assassin', 320, 82, 12, 128), ('knight', 520, 55, 28, 92),
      ('druid', 430, 62, 20, 102), ('archer', 350, 68, 15, 122)
    ) archetypes(hero_class, hp, atk, def, speed)
    WHERE hero_class = v_class;
    SELECT scale INTO v_rarity_scale
    FROM (VALUES
      ('common', 1::numeric), ('uncommon', 1.5), ('rare', 2.2), ('epic', 3.2),
      ('legendary', 4.6), ('mythic', 6.5), ('cosmic', 9), ('divine', 13), ('celestial', 18)
    ) rarities(rarity, scale)
    WHERE rarity = v_rarity;
    v_star_scale := public.dungeon_star_multiplier(v_stars);

    v_equipped_map := COALESCE(v_hero->'equipped', '{}'::jsonb);
    IF jsonb_typeof(v_equipped_map) <> 'object' THEN RAISE EXCEPTION 'dungeon_equipment_state_mismatch'; END IF;
    v_equipment := '[]'::jsonb;
    v_item_hp := 0; v_item_atk := 0; v_item_def := 0; v_item_attack_speed := 0;
    v_item_count := 0; v_set_rarity := NULL;

    FOR v_equipment_entry IN
      SELECT key AS slot, value AS item_id FROM jsonb_each_text(v_equipped_map)
      WHERE key IN ('class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet')
      ORDER BY key
    LOOP
      IF v_equipment_entry.item_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
        RAISE EXCEPTION 'dungeon_equipment_state_mismatch';
      END IF;
      SELECT * INTO v_item FROM public.player_items
      WHERE id = v_equipment_entry.item_id::uuid AND player_id = p_player_id AND removed_at IS NULL;
      IF NOT FOUND OR v_item.id = ANY(v_seen_items) THEN RAISE EXCEPTION 'dungeon_equipment_state_mismatch'; END IF;
      IF v_item.slot <> v_equipment_entry.slot THEN RAISE EXCEPTION 'dungeon_equipment_state_mismatch'; END IF;
      IF v_equipment_entry.slot IN ('class_weapon', 'offhand') THEN
        v_item_class := CASE split_part(v_item.base_item_id, '-', 2)
          WHEN 'mage' THEN 'shepherd' WHEN 'warrior' THEN 'knight' WHEN 'crossbowman' THEN 'archer'
          WHEN 'assassin' THEN 'assassin' WHEN 'druid' THEN 'druid' ELSE NULL END;
        IF v_item_class IS NULL OR v_item_class <> v_class THEN RAISE EXCEPTION 'dungeon_equipment_state_mismatch'; END IF;
      END IF;
      v_seen_items := array_append(v_seen_items, v_item.id);
      v_item_count := v_item_count + 1;
      v_set_rarity := CASE WHEN v_item_count = 1 OR v_set_rarity = v_item.rarity THEN v_item.rarity ELSE '' END;
      v_enchant_multiplier := 1 + LEAST(10, GREATEST(0, v_item.enchant_level)) * 0.1;

      FOR v_stat IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_item.stats) = 'array' THEN v_item.stats ELSE '[]'::jsonb END) LOOP
        IF jsonb_typeof(v_stat->'value') <> 'number' THEN CONTINUE; END IF;
        v_stat_value := LEAST(1000000000::numeric, GREATEST(-1000000000::numeric, (v_stat->>'value')::numeric));
        v_stat_value := CASE WHEN COALESCE((v_stat->>'isPercent')::boolean, false)
          THEN round(v_stat_value * v_enchant_multiplier, 3) ELSE round(v_stat_value * v_enchant_multiplier) END;
        CASE v_stat->>'key'
          WHEN 'hp' THEN v_item_hp := v_item_hp + v_stat_value;
          WHEN 'atk' THEN v_item_atk := v_item_atk + v_stat_value;
          WHEN 'def' THEN v_item_def := v_item_def + v_stat_value;
          WHEN 'atkSpeed' THEN v_item_attack_speed := v_item_attack_speed + v_stat_value;
          ELSE NULL;
        END CASE;
      END LOOP;

      v_equipment := v_equipment || jsonb_build_array(jsonb_build_object(
        'slot', v_equipment_entry.slot, 'item_id', v_item.id, 'base_item_id', v_item.base_item_id,
        'item_level', v_item.item_level, 'rarity', v_item.rarity, 'stats', v_item.stats,
        'power', v_item.power, 'enchant_level', v_item.enchant_level, 'reroll_count', v_item.reroll_count
      ));
    END LOOP;

    IF (SELECT count(*) FROM jsonb_object_keys(v_equipped_map)) <> v_item_count THEN
      RAISE EXCEPTION 'dungeon_equipment_state_mismatch';
    END IF;
    v_set_multiplier := 1 + CASE WHEN v_item_count = 8 THEN CASE v_set_rarity
      WHEN 'common' THEN 0.02 WHEN 'uncommon' THEN 0.04 WHEN 'rare' THEN 0.06 WHEN 'epic' THEN 0.08
      WHEN 'legendary' THEN 0.10 WHEN 'mythic' THEN 0.12 WHEN 'cosmic' THEN 0.14
      WHEN 'divine' THEN 0.16 WHEN 'celestial' THEN 0.18 WHEN 'cursed' THEN 0.20
      WHEN 'immortal' THEN 0.22 WHEN 'god' THEN 0.25 ELSE 0 END ELSE 0 END;
    v_item_hp := v_item_hp * v_set_multiplier; v_item_atk := v_item_atk * v_set_multiplier;
    v_item_def := v_item_def * v_set_multiplier; v_item_attack_speed := v_item_attack_speed * v_set_multiplier;
    v_hp := round(round(v_base_hp * v_rarity_scale) * 0.2 * (1 + (v_level - 1) * 0.06) * v_star_scale + v_item_hp);
    v_atk := round(round(v_base_atk * v_rarity_scale) * 0.2 * (1 + (v_level - 1) * 0.05) * v_star_scale + v_item_atk);
    v_def := round((round(v_base_def * v_rarity_scale) * 0.2 * v_star_scale + v_item_def)
      * CASE WHEN v_class = 'knight' THEN 1.05 ELSE 1 END);
    v_power := round(v_atk + v_hp * 0.08 + v_def * 1.5 + v_item_attack_speed * 2, 3);

    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
      'position', jsonb_array_length(v_snapshot) + 1, 'uid', v_uid, 'hero_id', v_hero_id,
      'level', v_level, 'stars', v_stars, 'equipment', v_equipment,
      'stats', jsonb_build_object('hp', v_hp, 'atk', v_atk, 'def', v_def, 'speed', v_base_speed,
        'attack_speed_bonus', round(v_item_attack_speed, 3), 'power', v_power)
    ));
  END LOOP;
  RETURN v_snapshot;
END;
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
      'seed', v_active.seed, 'roster_snapshot', v_active.roster_snapshot, 'started_at', v_active.started_at);
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

CREATE OR REPLACE FUNCTION public.dungeon_start(p_player_id uuid, p_depth integer, p_idempotency_key uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('depth', p_depth);
  v_save public.player_saves%ROWTYPE;
  v_player_state public.dungeon_player_state%ROWTYPE;
  v_week date := public.dungeon_week_start(now());
  v_account_level integer;
  v_snapshot jsonb;
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_seed bigint;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'start' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF p_depth IS NULL OR p_depth NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'dungeon_invalid_depth'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF COALESCE(v_save.state->>'accountLevel', '') !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'dungeon_invalid_progression'; END IF;
  v_account_level := LEAST(99, GREATEST(1, (v_save.state->>'accountLevel')::integer));
  IF EXISTS (SELECT 1 FROM public.dungeon_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.boss_encounters WHERE player_id = p_player_id AND status = 'active') THEN
    RAISE EXCEPTION 'active_encounter_exists';
  END IF;
  INSERT INTO public.dungeon_player_state(player_id, attempt_week) VALUES (p_player_id, v_week)
  ON CONFLICT (player_id) DO NOTHING;
  SELECT * INTO v_player_state FROM public.dungeon_player_state WHERE player_id = p_player_id FOR UPDATE;
  IF v_player_state.attempt_week <> v_week THEN
    UPDATE public.dungeon_player_state SET attempt_week = v_week, attempts_remaining = 3, updated_at = now()
    WHERE player_id = p_player_id RETURNING * INTO v_player_state;
  END IF;
  IF (p_depth = 1 AND v_account_level < 30)
    OR (p_depth = 2 AND (v_account_level < 55 OR v_player_state.max_depth_cleared < 1))
    OR (p_depth = 3 AND (v_account_level < 80 OR v_player_state.max_depth_cleared < 2)) THEN
    RAISE EXCEPTION 'dungeon_depth_locked';
  END IF;
  IF v_player_state.attempts_remaining <= 0 THEN RAISE EXCEPTION 'dungeon_attempts_exhausted'; END IF;
  v_snapshot := public.dungeon_roster_snapshot(p_player_id, v_save.state);
  v_seed := (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))::bit(64)::bigint);
  INSERT INTO public.dungeon_encounters(player_id, depth, balance_version, seed, roster_snapshot)
  VALUES (p_player_id, p_depth, '2026.08.13-dungeon-core-v1', v_seed, v_snapshot) RETURNING * INTO v_encounter;
  UPDATE public.dungeon_player_state SET attempts_remaining = attempts_remaining - 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING * INTO v_player_state;
  v_result := jsonb_build_object(
    'attempts_remaining', v_player_state.attempts_remaining, 'attempts_max', 3,
    'week_start', v_player_state.attempt_week, 'next_reset_at', public.dungeon_next_reset(now()),
    'encounter', jsonb_build_object(
      'type', 'dungeon', 'encounter_id', v_encounter.id, 'depth', v_encounter.depth,
      'room', v_encounter.room, 'revision', v_encounter.revision, 'balance_version', v_encounter.balance_version,
      'seed', v_encounter.seed, 'roster_snapshot', v_encounter.roster_snapshot, 'started_at', v_encounter.started_at));
  INSERT INTO public.dungeon_events(idempotency_key, player_id, encounter_id, action, request, result)
  VALUES (p_idempotency_key, p_player_id, v_encounter.id, 'start', v_request, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_abandon(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id', p_encounter_id, 'expected_revision', p_expected_revision);
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_status jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'abandon' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN RAISE EXCEPTION 'dungeon_invalid_revision'; END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id = p_encounter_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status <> 'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision <> p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  UPDATE public.dungeon_encounters SET status = 'abandoned', revision = revision + 1, completed_at = now()
  WHERE id = p_encounter_id RETURNING * INTO v_encounter;
  v_status := public.dungeon_status(p_player_id);
  v_result := jsonb_build_object(
    'encounter_id', v_encounter.id, 'status', v_encounter.status, 'revision', v_encounter.revision,
    'attempts_remaining', v_status->'attempts_remaining', 'next_reset_at', v_status->'next_reset_at');
  INSERT INTO public.dungeon_events(idempotency_key, player_id, encounter_id, action, request, result)
  VALUES (p_idempotency_key, p_player_id, v_encounter.id, 'abandon', v_request, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.summon_boss(p_player_id uuid, p_location integer)
RETURNS TABLE(encounter_id uuid, remaining_keys integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_encounter uuid;
  v_keys integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.dungeon_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.boss_encounters WHERE player_id = p_player_id AND status = 'active') THEN
    RAISE EXCEPTION 'active_encounter_exists';
  END IF;
  UPDATE public.players SET boss_keys = boss_keys - 1, updated_at = now()
  WHERE player_id = p_player_id AND boss_keys > 0 RETURNING boss_keys INTO v_keys;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_key_required'; END IF;
  INSERT INTO public.boss_encounters(player_id, location_id)
  VALUES (p_player_id, GREATEST(1, p_location)) RETURNING id INTO v_encounter;
  RETURN QUERY SELECT v_encounter, v_keys;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_week_start(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_next_reset(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_unlocks(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_star_multiplier(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_roster_snapshot(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_start(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_abandon(uuid, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.summon_boss(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_status(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_start(uuid, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_abandon(uuid, uuid, bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.summon_boss(uuid, integer) TO service_role;
