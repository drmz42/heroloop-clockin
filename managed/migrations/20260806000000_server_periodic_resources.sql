-- Server-authoritative periodic Gold and chest accrual for reward-active players.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS resource_reward_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.credit_periodic_resources(p_player_id uuid, p_seconds numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_seconds numeric;
  v_previous_tick timestamptz;
  v_tick timestamptz := clock_timestamp();
  v_progress numeric;
  v_gold_progress numeric;
  v_battles integer;
  v_chests integer;
  v_location integer;
  v_gold integer;
  v_now_ms bigint := FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000);
  v_day text := to_char(clock_timestamp() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  v_last_day text;
  v_new_chests jsonb := '[]'::jsonb;
BEGIN
  SELECT resource_reward_at INTO v_previous_tick
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('gold', 0, 'chests', 0); END IF;
  v_seconds := LEAST(LEAST(60, GREATEST(0, p_seconds)), GREATEST(0, EXTRACT(EPOCH FROM (v_tick - v_previous_tick))));
  UPDATE public.players SET resource_reward_at = v_tick WHERE player_id = p_player_id;
  IF v_seconds <= 0 THEN RETURN jsonb_build_object('gold', 0, 'chests', 0); END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('gold', 0, 'chests', 0); END IF;
  v_state := v_save.state;

  v_last_day := to_char(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms));
  END IF;

  v_progress := COALESCE((v_state#>>'{boost,chestProgressSeconds}')::numeric, 0) + v_seconds;
  v_chests := LEAST(
    FLOOR(v_progress / 86.4)::integer,
    GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->'chests', '[]'::jsonb))),
    GREATEST(0, 1000 - COALESCE((v_state->>'chestsOpenedToday')::integer, 0))
  );
  IF v_chests > 0 THEN
    SELECT jsonb_agg(jsonb_build_object('id', 'server-' || gen_random_uuid()::text, 'stage', GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1))))
    INTO v_new_chests FROM generate_series(1, v_chests);
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) || COALESCE(v_new_chests, '[]'::jsonb));
    v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + v_chests));
  END IF;
  v_state := jsonb_set(v_state, '{boost,chestProgressSeconds}', to_jsonb(v_progress - FLOOR(v_progress / 86.4) * 86.4));

  v_gold_progress := COALESCE((v_state#>>'{boost,goldProgressSeconds}')::numeric, 0) + v_seconds;
  v_battles := FLOOR(v_gold_progress / 12)::integer;
  v_location := GREATEST(1, COALESCE((v_state->>'currentLocation')::integer, 1));
  v_gold := v_battles * (5 + v_location);
  IF v_gold > 0 THEN
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold));
    v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold));
  END IF;
  v_state := jsonb_set(v_state, '{boost,goldProgressSeconds}', to_jsonb(v_gold_progress - v_battles * 12));
  v_state := jsonb_set(v_state, '{lastSeen}', to_jsonb(v_now_ms));

  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = clock_timestamp()
  WHERE player_id = p_player_id;
  RETURN jsonb_build_object('gold', v_gold, 'chests', v_chests, 'revision', v_save.revision + 1);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_periodic_resources(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_periodic_resources(uuid, numeric) TO service_role;
