\set ON_ERROR_STOP on

CREATE TABLE heroloop_api.siws_wallet_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  wallet_hash text NOT NULL CHECK (wallet_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes')
);

CREATE INDEX siws_wallet_sessions_expiry_idx
  ON heroloop_api.siws_wallet_sessions (expires_at);
CREATE INDEX siws_wallet_sessions_wallet_idx
  ON heroloop_api.siws_wallet_sessions (wallet_hash, expires_at DESC);

CREATE OR REPLACE FUNCTION heroloop_api.consume_siws_challenge_and_issue_session(
  p_request_id uuid,
  p_nonce_hash text,
  p_message_hash text,
  p_wallet_hash text,
  p_wallet_address text,
  p_token_hash text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_consumed jsonb;
  v_session_id uuid;
BEGIN
  IF p_request_id IS NULL
    OR p_nonce_hash IS NULL OR p_nonce_hash !~ '^[0-9a-f]{64}$'
    OR p_message_hash IS NULL OR p_message_hash !~ '^[0-9a-f]{64}$'
    OR p_wallet_hash IS NULL OR p_wallet_hash !~ '^[0-9a-f]{64}$'
    OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
    OR p_wallet_address IS NULL OR p_wallet_address !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    OR p_issued_at IS NULL
    OR p_issued_at NOT BETWEEN v_now - interval '30 seconds' AND v_now + interval '30 seconds'
    OR p_expires_at IS NULL OR p_expires_at <= v_now
    OR p_expires_at > p_issued_at + interval '15 minutes'
    OR p_expires_at < p_issued_at + interval '1 minute' THEN
    RAISE EXCEPTION 'api_invalid_siws_session';
  END IF;

  v_consumed := heroloop_api.consume_siws_challenge(
    p_request_id, p_nonce_hash, p_message_hash, p_wallet_hash, true
  );
  IF coalesce((v_consumed->>'consumed')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('issued', false);
  END IF;

  DELETE FROM heroloop_api.siws_wallet_sessions
  WHERE session_id IN (
    SELECT session_id FROM heroloop_api.siws_wallet_sessions
    WHERE expires_at < v_now - interval '1 day' OR revoked_at < v_now - interval '1 day'
    ORDER BY expires_at
    LIMIT 100
  );

  INSERT INTO heroloop_api.siws_wallet_sessions (
    token_hash, wallet_address, wallet_hash, issued_at, expires_at
  ) VALUES (
    p_token_hash, p_wallet_address, p_wallet_hash, p_issued_at, p_expires_at
  )
  RETURNING session_id INTO v_session_id;

  RETURN jsonb_build_object(
    'issued', true,
    'session_id', v_session_id,
    'expires_at', p_expires_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.validate_siws_wallet_session(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_session heroloop_api.siws_wallet_sessions%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  SELECT * INTO v_session
  FROM heroloop_api.siws_wallet_sessions
  WHERE token_hash = p_token_hash
    AND revoked_at IS NULL
    AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN jsonb_build_object('valid', false); END IF;
  RETURN jsonb_build_object(
    'valid', true,
    'address', v_session.wallet_address,
    'expires_at', v_session.expires_at
  );
END
$function$;

REVOKE ALL ON TABLE heroloop_api.siws_wallet_sessions
  FROM PUBLIC, anon, authenticated, heroloop_api;
REVOKE ALL ON FUNCTION heroloop_api.consume_siws_challenge_and_issue_session(uuid, text, text, text, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION heroloop_api.validate_siws_wallet_session(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.consume_siws_challenge_and_issue_session(uuid, text, text, text, text, text, timestamptz, timestamptz)
  TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.validate_siws_wallet_session(text)
  TO heroloop_api;

COMMENT ON TABLE heroloop_api.siws_wallet_sessions IS
  'Short-lived SIWS wallet-verification sessions; stores only HMAC bearer hashes and verified wallet subjects, never plaintext tokens.';
COMMENT ON FUNCTION heroloop_api.consume_siws_challenge_and_issue_session(uuid, text, text, text, text, text, timestamptz, timestamptz) IS
  'Consumes one verified SIWS challenge and inserts its 15-minute wallet-bound session in the same PostgreSQL transaction.';
