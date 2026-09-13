\set ON_ERROR_STOP on

ALTER TABLE heroloop_api.siws_wallet_sessions
  ADD COLUMN account_login_claimed_at timestamptz,
  ADD COLUMN account_login_request_id uuid UNIQUE;

CREATE OR REPLACE FUNCTION heroloop_api.claim_siws_account_login(
  p_token_hash text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_session heroloop_api.siws_wallet_sessions%ROWTYPE;
  v_identity_account_id uuid;
  v_allowed boolean;
BEGIN
  IF p_request_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'api_invalid_account_login';
  END IF;

  SELECT * INTO v_session
  FROM heroloop_api.siws_wallet_sessions
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now
    OR v_session.account_login_claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  v_allowed := public.consume_edge_rate_limit(
    v_session.wallet_hash, 'siws_account_login', 5, 300
  );
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('claimed', false, 'code', 'rate_limited');
  END IF;

  SELECT account_id INTO v_identity_account_id
  FROM heroloop_api.account_identities
  WHERE provider = 'solana' AND provider_subject = v_session.wallet_address
    AND state = 'active';

  UPDATE heroloop_api.siws_wallet_sessions
  SET account_login_claimed_at = v_now,
      account_login_request_id = p_request_id
  WHERE session_id = v_session.session_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'address', v_session.wallet_address,
    'account_id', v_identity_account_id
  );
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.claim_siws_account_login(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.claim_siws_account_login(text, uuid)
  TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.claim_siws_account_login(text, uuid) IS
  'Burns one fresh verified-wallet bearer before the internal-only GoTrue Web3 exchange and returns only its address plus any existing HeroLoop account binding.';
