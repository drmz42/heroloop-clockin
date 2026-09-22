ALTER FUNCTION public.settle_periodic_progression(uuid, timestamptz)
  RENAME TO settle_periodic_progression_before_pending_normal_recovery;

REVOKE ALL ON FUNCTION public.settle_periodic_progression_before_pending_normal_recovery(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression(p_player_id uuid, p_tick timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_normal_mode boolean;
  v_online boolean;
  v_pending record;
BEGIN
  SELECT normal_combat_mode, online
  INTO v_normal_mode, v_online
  FROM public.players
  WHERE player_id = p_player_id;

  IF COALESCE(v_normal_mode, false) THEN
    SELECT start_key, id, available_at
    INTO v_pending
    FROM public.normal_combat_events
    WHERE player_id = p_player_id
      AND completed_at IS NULL
      AND outcome IS NOT NULL
      AND available_at <= p_tick
    ORDER BY started_at
    LIMIT 1;

    IF FOUND THEN
      -- The API has already produced and stored the deterministic outcome.
      -- Reusing the event id gives the worker one stable completion key; the
      -- normal combat locks make a simultaneous browser completion a replay.
      PERFORM public.normal_combat_complete(p_player_id, v_pending.start_key, v_pending.id);

      IF NOT COALESCE(v_online, false) THEN
        -- The completed exact wave owns time through available_at. Start the
        -- ordinary offline settlement after it so the same interval cannot be
        -- rewarded once as a normal wave and again as simulated AFK combat.
        UPDATE public.players
        SET resource_reward_at = GREATEST(resource_reward_at, v_pending.available_at)
        WHERE player_id = p_player_id;
      END IF;
    END IF;
  END IF;

  RETURN public.settle_periodic_progression_before_pending_normal_recovery(p_player_id, p_tick);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_periodic_progression(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) IS
  'Completes a ready deterministic normal wave before periodic hidden/offline settlement, with a non-overlapping reward clock.';
