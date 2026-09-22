CREATE OR REPLACE FUNCTION public.set_boost_max_active(p_player_id uuid, p_active boolean)
RETURNS TABLE (
  active boolean,
  login_days integer,
  online_seconds bigint,
  tokens_earned numeric,
  tokens_spent numeric,
  token_balance numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_active AND NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE player_id = p_player_id
      AND boost_login_days >= 1
      AND boost_online_seconds >= 60
      AND boost_tokens_earned >= 500
      AND boost_tokens_spent >= 500
      AND players.token_balance >= 1000
  ) THEN
    RAISE EXCEPTION 'boost_requirements_incomplete';
  END IF;

  RETURN QUERY
  UPDATE public.players
  SET boost_max_active = p_active, updated_at = now()
  WHERE player_id = p_player_id
  RETURNING players.boost_max_active, players.boost_login_days, players.boost_online_seconds,
    players.boost_tokens_earned, players.boost_tokens_spent, players.token_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.set_boost_max_active(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_boost_max_active(uuid, boolean) TO service_role;
