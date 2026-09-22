-- Timed-chest ids were 'server-' plus a 36-character UUID (~40% of a capped
-- save after compression). New chests get 's' plus 12 random hex characters;
-- ids only need to be unique within one player's chest list (<= 500 entries).
-- Existing chests keep their ids because the browser still holds them.
-- Body below is 20260809000000_server_combat_progression.sql unchanged except
-- the chest id expression; it runs today as settle_periodic_progression_legacy.
CREATE FUNCTION public.new_chest_id()
RETURNS text
LANGUAGE sql VOLATILE
SET search_path = pg_catalog, public
AS $$
  SELECT 's' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;

REVOKE ALL ON FUNCTION public.new_chest_id() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression_legacy(p_player_id uuid, p_tick timestamptz)
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
    SELECT jsonb_agg(jsonb_build_object('id', public.new_chest_id(), 'stage', GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))))
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

REVOKE ALL ON FUNCTION public.settle_periodic_progression_legacy(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
