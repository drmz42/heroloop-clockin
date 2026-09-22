CREATE OR REPLACE FUNCTION public.record_player_heartbeat(p_player_id uuid)
RETURNS TABLE (login_days integer, online_seconds bigint, reward_active_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_day date := (v_now AT TIME ZONE 'Europe/Moscow')::date;
BEGIN
  RETURN QUERY
  UPDATE public.players AS p
  SET
    boost_online_seconds = p.boost_online_seconds + CASE
      WHEN p.last_heartbeat IS NOT NULL AND p.last_heartbeat >= v_now - interval '60 seconds'
        THEN LEAST(60, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - p.last_heartbeat)))::bigint))
      ELSE 0
    END,
    boost_login_days = p.boost_login_days + CASE WHEN p.boost_last_login_day IS DISTINCT FROM v_day THEN 1 ELSE 0 END,
    boost_last_login_day = v_day,
    online = true,
    last_heartbeat = v_now,
    resource_reward_at = CASE
      WHEN NOT p.boost_max_active AND p.reward_active_until < v_now THEN GREATEST(p.resource_reward_at, v_now)
      ELSE p.resource_reward_at
    END,
    reward_active_until = v_now + interval '8 hours',
    updated_at = v_now
  WHERE p.player_id = p_player_id
  RETURNING p.boost_login_days, p.boost_online_seconds, p.reward_active_until;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_player_heartbeat(uuid) TO service_role;
