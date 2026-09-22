ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS token_balance numeric NOT NULL DEFAULT 0 CHECK (token_balance >= 0),
  ADD COLUMN IF NOT EXISTS boost_tokens_earned numeric NOT NULL DEFAULT 0 CHECK (boost_tokens_earned >= 0),
  ADD COLUMN IF NOT EXISTS boost_tokens_spent numeric NOT NULL DEFAULT 0 CHECK (boost_tokens_spent >= 0),
  ADD COLUMN IF NOT EXISTS boost_login_days integer NOT NULL DEFAULT 0 CHECK (boost_login_days >= 0),
  ADD COLUMN IF NOT EXISTS boost_last_login_day date,
  ADD COLUMN IF NOT EXISTS boost_online_seconds bigint NOT NULL DEFAULT 0 CHECK (boost_online_seconds >= 0),
  ADD COLUMN IF NOT EXISTS boost_max_active boolean NOT NULL DEFAULT false;

UPDATE public.players AS p
SET token_balance = LEAST(1000000000000::numeric, GREATEST(0::numeric, (s.state->>'hero')::numeric))
FROM public.player_saves AS s
WHERE s.player_id = p.player_id
  AND s.state->>'hero' ~ '^[0-9]+([.][0-9]+)?$'
  AND p.token_balance = 0;

CREATE TABLE IF NOT EXISTS public.token_spend_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  action_kind text NOT NULL CHECK (char_length(action_kind) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.token_spend_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.token_spend_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_player_heartbeat(p_player_id uuid)
RETURNS TABLE (
  login_days integer,
  online_seconds bigint,
  reward_active_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    boost_login_days = boost_login_days + CASE
      WHEN boost_last_login_day IS DISTINCT FROM v_day THEN 1 ELSE 0
    END,
    boost_last_login_day = v_day,
    online = true,
    last_heartbeat = v_now,
    reward_active_until = v_now + interval '8 hours',
    updated_at = v_now
  WHERE player_id = p_player_id
  RETURNING boost_login_days, boost_online_seconds, players.reward_active_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.credit_token_distribution(p_player_id uuid, p_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_amount <= 0 THEN RETURN false; END IF;
  UPDATE public.players
  SET pending_tokens = pending_tokens + p_amount,
      boost_tokens_earned = boost_tokens_earned + p_amount,
      updated_at = now()
  WHERE player_id = p_player_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_player_tokens(p_player_id uuid)
RETURNS TABLE (claimed numeric, pending numeric, total_claimed numeric, token_balance numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim numeric;
BEGIN
  SELECT FLOOR(p.pending_tokens) INTO v_claim
  FROM public.players p
  WHERE p.player_id = p_player_id
  FOR UPDATE;

  IF v_claim IS NULL THEN RAISE EXCEPTION 'player_not_found'; END IF;

  RETURN QUERY
  UPDATE public.players
  SET pending_tokens = pending_tokens - v_claim,
      total_claimed = players.total_claimed + v_claim,
      token_balance = players.token_balance + v_claim,
      updated_at = now()
  WHERE player_id = p_player_id
  RETURNING v_claim, players.pending_tokens, players.total_claimed, players.token_balance;
END;
$$;

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
BEGIN
  IF p_amount <= 0 OR p_action_kind !~ '^[a-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid_spend';
  END IF;

  SELECT * INTO v_existing
  FROM public.token_spend_events
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.amount <> p_amount OR v_existing.action_kind <> p_action_kind THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN QUERY SELECT v_existing.amount, p.token_balance, p.boost_tokens_spent
      FROM public.players p WHERE p.player_id = p_player_id;
    RETURN;
  END IF;

  UPDATE public.players
  SET token_balance = players.token_balance - p_amount,
      boost_tokens_spent = players.boost_tokens_spent + p_amount,
      updated_at = now()
  WHERE player_id = p_player_id AND players.token_balance >= p_amount
  RETURNING players.token_balance, players.boost_tokens_spent
  INTO token_balance, boost_tokens_spent;

  IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  INSERT INTO public.token_spend_events (idempotency_key, player_id, amount, action_kind)
  VALUES (p_idempotency_key, p_player_id, p_amount, p_action_kind);

  spent := p_amount;
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
      AND boost_login_days >= 3
      AND boost_online_seconds >= 28800
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
  RETURNING boost_max_active, boost_login_days, boost_online_seconds,
    boost_tokens_earned, boost_tokens_spent, players.token_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.record_player_heartbeat(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_token_distribution(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_player_tokens(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_boost_max_active(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_player_heartbeat(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_token_distribution(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_player_tokens(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_boost_max_active(uuid, boolean) TO service_role;
