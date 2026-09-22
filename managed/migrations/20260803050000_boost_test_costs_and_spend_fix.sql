CREATE OR REPLACE FUNCTION public.settle_token_spend(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_amount numeric,
  p_action_kind text
)
RETURNS TABLE (spent numeric, token_balance numeric, boost_tokens_spent numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.token_spend_events%ROWTYPE;
  v_balance numeric;
  v_total_spent numeric;
BEGIN
  IF p_amount <= 0 OR p_action_kind !~ '^[a-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_spend';
  END IF;

  SELECT e.* INTO v_existing
  FROM public.token_spend_events AS e
  WHERE e.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.amount <> p_amount OR v_existing.action_kind <> p_action_kind THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    SELECT p.token_balance, p.boost_tokens_spent
      INTO v_balance, v_total_spent
    FROM public.players AS p
    WHERE p.player_id = p_player_id;
  ELSE
    UPDATE public.players AS p
    SET token_balance = p.token_balance - p_amount,
        boost_tokens_spent = p.boost_tokens_spent + p_amount,
        updated_at = now()
    WHERE p.player_id = p_player_id
      AND p.token_balance >= p_amount
    RETURNING p.token_balance, p.boost_tokens_spent
      INTO v_balance, v_total_spent;

    IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

    INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
    VALUES (p_idempotency_key, p_player_id, p_amount, p_action_kind);
  END IF;

  spent := p_amount;
  token_balance := v_balance;
  boost_tokens_spent := v_total_spent;
  RETURN NEXT;
END;
$$;

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
      AND boost_tokens_earned >= 10
      AND boost_tokens_spent >= 10
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

REVOKE ALL ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_boost_max_active(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_boost_max_active(uuid, boolean) TO service_role;
