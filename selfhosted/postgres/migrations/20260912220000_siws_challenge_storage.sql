\set ON_ERROR_STOP on

CREATE TABLE heroloop_api.siws_challenges (
  request_id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'solana' CHECK (provider = 'solana'),
  nonce_hash text NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  message_hash text NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  wallet_hash text NOT NULL CHECK (wallet_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes')
);

CREATE INDEX siws_challenges_expiry_idx ON heroloop_api.siws_challenges (expires_at);

CREATE OR REPLACE FUNCTION heroloop_api.issue_siws_challenge(
  p_request_id uuid,
  p_nonce_hash text,
  p_message_hash text,
  p_wallet_hash text,
  p_rate_subject_hash text,
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
  v_ip_allowed boolean;
  v_wallet_allowed boolean;
BEGIN
  IF p_nonce_hash !~ '^[0-9a-f]{64}$'
    OR p_message_hash !~ '^[0-9a-f]{64}$'
    OR p_wallet_hash !~ '^[0-9a-f]{64}$'
    OR p_rate_subject_hash !~ '^[0-9a-f]{64}$'
    OR p_issued_at NOT BETWEEN v_now - interval '30 seconds' AND v_now + interval '30 seconds'
    OR p_expires_at <= v_now
    OR p_expires_at > p_issued_at + interval '5 minutes'
    OR p_expires_at < p_issued_at + interval '1 minute' THEN
    RAISE EXCEPTION 'api_invalid_siws_challenge';
  END IF;

  v_ip_allowed := public.consume_edge_rate_limit(
    'siws-ip:' || p_rate_subject_hash, 'siws_challenge_ip', 10, 300
  );
  v_wallet_allowed := public.consume_edge_rate_limit(
    'siws-wallet:' || p_wallet_hash, 'siws_challenge_wallet', 5, 300
  );
  IF NOT v_ip_allowed OR NOT v_wallet_allowed THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', 300);
  END IF;

  DELETE FROM heroloop_api.siws_challenges
  WHERE request_id IN (
    SELECT request_id FROM heroloop_api.siws_challenges
    WHERE expires_at < v_now - interval '1 day'
    ORDER BY expires_at
    LIMIT 100
  );

  INSERT INTO heroloop_api.siws_challenges (
    request_id, nonce_hash, message_hash, wallet_hash, issued_at, expires_at
  ) VALUES (
    p_request_id, p_nonce_hash, p_message_hash, p_wallet_hash, p_issued_at, p_expires_at
  );
  RETURN jsonb_build_object('allowed', true);
END
$function$;

REVOKE ALL ON TABLE heroloop_api.siws_challenges FROM PUBLIC, anon, authenticated, heroloop_api;
REVOKE ALL ON FUNCTION heroloop_api.issue_siws_challenge(uuid, text, text, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.issue_siws_challenge(uuid, text, text, text, text, timestamptz, timestamptz)
  TO heroloop_api;

COMMENT ON TABLE heroloop_api.siws_challenges IS
  'Short-lived single-use SIWS challenge hashes; never stores raw nonce, message, wallet address, signature or IP.';
COMMENT ON FUNCTION heroloop_api.issue_siws_challenge(uuid, text, text, text, text, timestamptz, timestamptz) IS
  'Atomically rate-limits and stores one hashed five-minute Solana challenge for future verification.';
