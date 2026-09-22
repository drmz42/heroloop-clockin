-- Idempotent server-owned periodic combat progression.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS combat_power bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.account_xp_needed(p_level integer)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT CASE
    WHEN p_level < 20 THEN ROUND(1800 + p_level * 85)::integer
    WHEN p_level < 29 THEN ROUND(5200 + (p_level - 20) * 180)::integer
    ELSE LEAST(18000, ROUND(7000 + (p_level - 29) * 550)::integer)
  END;
$$;

CREATE OR REPLACE FUNCTION public.hero_xp_needed(p_level integer)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT GREATEST(1, ROUND(public.account_xp_needed(p_level) / 1.3)::integer);
$$;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression(p_player_id uuid, p_tick timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_previous_tick timestamptz;
  v_reward_active_until timestamptz;
  v_boost_max_active boolean;
  v_combat_power bigint;
  v_tick timestamptz := LEAST(COALESCE(p_tick, clock_timestamp()), clock_timestamp() + interval '5 seconds');
  v_reward_end timestamptz;
  v_seconds numeric;
  v_team jsonb;
  v_team_size integer;
  v_location integer;
  v_level_location_cap integer;
  v_can_clear boolean;
  v_combat_progress numeric;
  v_chest_progress numeric;
  v_battles integer;
  v_chests integer := 0;
  v_gold integer := 0;
  v_hero_xp integer := 0;
  v_account_xp integer := 0;
  v_kills integer := 0;
  v_total_account_xp bigint;
  v_account_level integer := 1;
  v_account_level_start bigint := 0;
  v_heroes jsonb;
  v_hero jsonb;
  v_hero_uid text;
  v_hero_level integer;
  v_hero_remaining bigint;
  v_index integer;
  v_now_ms bigint := FLOOR(EXTRACT(EPOCH FROM v_tick) * 1000);
  v_day text := to_char(v_tick AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  v_last_day text;
  v_new_chests jsonb := '[]'::jsonb;
BEGIN
  SELECT resource_reward_at, reward_active_until, boost_max_active, combat_power
  INTO v_previous_tick, v_reward_active_until, v_boost_max_active, v_combat_power
  FROM public.players
  WHERE player_id = p_player_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;

  IF v_tick <= v_previous_tick THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0, 'replayed', true);
  END IF;

  v_reward_end := CASE WHEN v_boost_max_active THEN v_tick ELSE LEAST(v_tick, v_reward_active_until) END;
  v_seconds := GREATEST(0, EXTRACT(EPOCH FROM (v_reward_end - v_previous_tick)));
  UPDATE public.players SET resource_reward_at = v_tick WHERE player_id = p_player_id;
  IF v_seconds <= 0 THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;
  v_state := v_save.state;
  v_team := COALESCE(v_state->'team', '[]'::jsonb);
  v_team_size := LEAST(3, jsonb_array_length(v_team));
  IF v_team_size <= 0 THEN
    RETURN jsonb_build_object('gold', 0, 'account_xp', 0, 'hero_xp', 0, 'kills', 0, 'chests', 0);
  END IF;
  v_level_location_cap := CASE
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 70 THEN 10
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 60 THEN 9
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 50 THEN 8
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 40 THEN 7
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 31 THEN 6
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 23 THEN 5
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 16 THEN 4
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 10 THEN 3
    WHEN COALESCE((v_state->>'accountLevel')::integer, 1) >= 5 THEN 2
    ELSE 1
  END;
  v_location := LEAST(
    GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1)),
    GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1)),
    v_level_location_cap
  );
  v_can_clear := v_combat_power > 0;

  v_last_day := to_char(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms));
  END IF;

  v_chest_progress := COALESCE((v_state#>>'{boost,chestProgressSeconds}')::numeric, 0) + v_seconds;
  v_chests := LEAST(
    FLOOR(v_chest_progress / 86.4)::integer,
    GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->'chests', '[]'::jsonb))),
    GREATEST(0, 1000 - COALESCE((v_state->>'chestsOpenedToday')::integer, 0))
  );
  IF v_chests > 0 THEN
    SELECT jsonb_agg(jsonb_build_object('id', 'server-' || gen_random_uuid()::text, 'stage', GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))))
    INTO v_new_chests FROM generate_series(1, v_chests);
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) || COALESCE(v_new_chests, '[]'::jsonb));
    v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + v_chests));
  END IF;
  v_state := jsonb_set(v_state, '{boost,chestProgressSeconds}', to_jsonb(v_chest_progress - FLOOR(v_chest_progress / 86.4) * 86.4));

  v_combat_progress := COALESCE((v_state#>>'{boost,combatProgressSeconds}')::numeric, 0) + v_seconds;
  v_battles := CASE WHEN v_can_clear THEN FLOOR(v_combat_progress / 12)::integer ELSE 0 END;
  v_state := jsonb_set(v_state, '{boost,combatProgressSeconds}', to_jsonb(CASE WHEN v_can_clear THEN v_combat_progress - v_battles * 12 ELSE 0 END));
  v_hero_xp := GREATEST(1, ROUND((4 + v_location * 1.2) * 0.55)::integer) * v_battles;
  v_kills := v_battles * v_team_size;
  v_account_xp := v_hero_xp * v_team_size;
  v_gold := v_battles * (5 + v_location) * v_team_size;

  IF v_battles > 0 THEN
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold));
    v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold));
    v_state := jsonb_set(v_state, '{totalKills}', to_jsonb(COALESCE((v_state->>'totalKills')::bigint, 0) + v_kills));
    v_state := jsonb_set(v_state, '{session,kills}', to_jsonb(COALESCE((v_state#>>'{session,kills}')::bigint, 0) + v_kills));
    v_state := jsonb_set(v_state, '{session,goldToday}', to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint, 0) + v_gold));

    v_total_account_xp := COALESCE((v_state->>'accountXp')::bigint, 0) + v_account_xp;
    LOOP
      EXIT WHEN v_total_account_xp < v_account_level_start + public.account_xp_needed(v_account_level);
      v_account_level_start := v_account_level_start + public.account_xp_needed(v_account_level);
      v_account_level := v_account_level + 1;
    END LOOP;
    v_state := jsonb_set(v_state, '{accountXp}', to_jsonb(v_total_account_xp));
    v_state := jsonb_set(v_state, '{accountLevel}', to_jsonb(v_account_level));
    IF v_location = GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1)) THEN
      v_state := jsonb_set(v_state, '{highestLocation}', to_jsonb(v_location + 1));
    END IF;

    v_heroes := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
    IF jsonb_array_length(v_heroes) > 0 THEN
      FOR v_index IN 0..jsonb_array_length(v_heroes) - 1 LOOP
        v_hero := v_heroes->v_index;
        v_hero_uid := v_hero->>'uid';
        IF v_team ? v_hero_uid THEN
          v_hero_level := GREATEST(1, COALESCE((v_hero->>'level')::integer, 1));
          v_hero_remaining := GREATEST(0, COALESCE((v_hero->>'xp')::bigint, 0)) + v_hero_xp;
          LOOP
            EXIT WHEN v_hero_remaining < public.hero_xp_needed(v_hero_level);
            v_hero_remaining := v_hero_remaining - public.hero_xp_needed(v_hero_level);
            v_hero_level := v_hero_level + 1;
          END LOOP;
          v_hero := jsonb_set(jsonb_set(v_hero, '{level}', to_jsonb(v_hero_level)), '{xp}', to_jsonb(v_hero_remaining));
          v_heroes := jsonb_set(v_heroes, ARRAY[v_index::text], v_hero);
        END IF;
      END LOOP;
    END IF;
    v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes);
  END IF;

  v_state := jsonb_set(v_state, '{lastSeen}', to_jsonb(v_now_ms));
  v_state := jsonb_set(v_state, '{combatXpAt}', to_jsonb(v_now_ms));
  UPDATE public.player_saves
  SET state = v_state, revision = revision + 1, updated_at = v_tick
  WHERE player_id = p_player_id;

  RETURN jsonb_build_object(
    'gold', v_gold, 'account_xp', v_account_xp, 'hero_xp', v_hero_xp,
    'kills', v_kills, 'chests', v_chests, 'revision', v_save.revision + 1, 'settled_through', v_tick
  );
END;
$$;

-- A new session must never revive an expired reward interval.
CREATE OR REPLACE FUNCTION public.record_player_heartbeat(p_player_id uuid)
RETURNS TABLE (login_days integer, online_seconds bigint, reward_active_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_day date := (v_now AT TIME ZONE 'Europe/Moscow')::date;
BEGIN
  RETURN QUERY
  UPDATE public.players
  SET
    boost_online_seconds = boost_online_seconds + CASE
      WHEN last_heartbeat IS NOT NULL AND last_heartbeat >= v_now - interval '60 seconds'
        THEN LEAST(60, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - last_heartbeat)))::bigint))
      ELSE 0
    END,
    boost_login_days = boost_login_days + CASE WHEN boost_last_login_day IS DISTINCT FROM v_day THEN 1 ELSE 0 END,
    boost_last_login_day = v_day,
    online = true,
    last_heartbeat = v_now,
    resource_reward_at = CASE
      WHEN NOT boost_max_active AND reward_active_until < v_now THEN GREATEST(resource_reward_at, v_now)
      ELSE resource_reward_at
    END,
    reward_active_until = v_now + interval '8 hours',
    updated_at = v_now
  WHERE player_id = p_player_id
  RETURNING boost_login_days, boost_online_seconds, players.reward_active_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_token_spend(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_action_kind text
)
RETURNS TABLE (spent numeric, token_balance numeric, boost_tokens_spent numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_existing public.token_spend_events%ROWTYPE;
  v_training_slots integer;
  v_expected_amount numeric;
BEGIN
  IF p_amount <= 0 OR p_action_kind !~ '^[a-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_spend';
  END IF;

  SELECT * INTO v_existing FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.amount <> p_amount OR v_existing.action_kind <> p_action_kind THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN QUERY SELECT v_existing.amount, p.token_balance, p.boost_tokens_spent FROM public.players p WHERE p.player_id = p_player_id;
    RETURN;
  END IF;

  SELECT p.token_balance, p.boost_tokens_spent
  INTO token_balance, boost_tokens_spent
  FROM public.players p WHERE p.player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'account_required'; END IF;

  SELECT * INTO v_existing FROM public.token_spend_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.amount <> p_amount OR v_existing.action_kind <> p_action_kind THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN QUERY SELECT v_existing.amount, token_balance, boost_tokens_spent;
    RETURN;
  END IF;

  IF p_action_kind = 'training-slot' THEN
    SELECT COUNT(*)::integer INTO v_training_slots
    FROM public.token_spend_events
    WHERE player_id = p_player_id AND action_kind = 'training-slot';
    v_expected_amount := CASE v_training_slots
      WHEN 0 THEN 50 WHEN 1 THEN 100 WHEN 2 THEN 200 WHEN 3 THEN 400
      WHEN 4 THEN 800 WHEN 5 THEN 1600 WHEN 6 THEN 3200 WHEN 7 THEN 6400
      ELSE NULL
    END;
    IF v_expected_amount IS NULL OR p_amount <> v_expected_amount THEN RAISE EXCEPTION 'invalid_training_purchase'; END IF;
  ELSIF p_action_kind = 'training-boost-2x-1h' THEN v_expected_amount := 25;
  ELSIF p_action_kind = 'training-boost-2x-4h' THEN v_expected_amount := 80;
  ELSIF p_action_kind = 'training-boost-4x-1h' THEN v_expected_amount := 60;
  ELSIF p_action_kind = 'training-boost-4x-4h' THEN v_expected_amount := 200;
  END IF;
  IF v_expected_amount IS NOT NULL AND p_amount <> v_expected_amount THEN RAISE EXCEPTION 'invalid_training_purchase'; END IF;
  IF token_balance < p_amount THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  UPDATE public.players p
  SET token_balance = p.token_balance - p_amount,
      boost_tokens_spent = p.boost_tokens_spent + p_amount,
      updated_at = now()
  WHERE p.player_id = p_player_id
  RETURNING p.token_balance, p.boost_tokens_spent INTO token_balance, boost_tokens_spent;
  INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, p_amount, p_action_kind);
  spent := p_amount;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.account_xp_needed(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hero_xp_needed(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) TO service_role;
