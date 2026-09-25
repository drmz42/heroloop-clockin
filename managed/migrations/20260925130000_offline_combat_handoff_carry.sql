-- Closing the game no longer loses the first minutes of offline combat.
--
-- A closed page stays "online" until its last heartbeat is more than 60
-- seconds older than a 30-second worker tick. During those ticks the worker
-- leaves combat to the browser, which is gone, so the reward clock advances
-- with combat paused and 60-120 seconds of combat time are lost on every close.
--
-- On the first offline settlement after browser play, that lost time is
-- carried into the server's combat progress once. It starts after the last
-- browser wave ended (so no second is paid twice), no earlier than 30 seconds
-- before the last heartbeat, and covers at most 150 seconds. Only combat is
-- carried: chests were already counted by the online ticks.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS offline_combat_carried_through timestamptz;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression_before_economy_telemetry(p_player_id uuid, p_tick timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_normal_mode boolean;
  v_online boolean;
  v_combat_power bigint;
  v_reward_at timestamptz;
  v_heartbeat timestamptz;
  v_carried_through timestamptz;
  v_wave_end timestamptz;
  v_carry numeric;
  v_result jsonb;
BEGIN
  SELECT normal_combat_mode, online, combat_power, resource_reward_at, last_heartbeat, offline_combat_carried_through
  INTO v_normal_mode, v_online, v_combat_power, v_reward_at, v_heartbeat, v_carried_through
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

  IF v_normal_mode AND v_combat_power > 0 AND v_reward_at IS NOT NULL AND v_reward_at < p_tick THEN
    SELECT max(event.available_at) INTO v_wave_end
    FROM public.normal_combat_events event
    WHERE event.player_id = p_player_id AND event.completed_at IS NOT NULL;
    v_carry := extract(epoch FROM v_reward_at - GREATEST(
      coalesce(v_wave_end, '-infinity'::timestamptz),
      coalesce(v_heartbeat - interval '30 seconds', '-infinity'::timestamptz),
      coalesce(v_carried_through, '-infinity'::timestamptz),
      v_reward_at - interval '150 seconds'));
    IF v_carry > 0 THEN
      UPDATE public.player_saves
      SET state = state || jsonb_build_object('boost', coalesce(state->'boost', '{}'::jsonb)
            || jsonb_build_object('combatProgressSeconds',
                 coalesce((state#>>'{boost,combatProgressSeconds}')::numeric, 0) + round(v_carry, 3))),
          revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id;
    END IF;
    -- The legacy settlement pays through p_tick, so nothing before it may be
    -- carried again until the browser plays another wave.
    UPDATE public.players SET offline_combat_carried_through = p_tick WHERE player_id = p_player_id;
  END IF;

  RETURN public.settle_periodic_progression_legacy(p_player_id, p_tick);
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_periodic_progression_before_economy_telemetry(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
