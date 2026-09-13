\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.consume_siws_challenge(
  p_request_id uuid,
  p_nonce_hash text,
  p_message_hash text,
  p_wallet_hash text,
  p_proof_valid boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_challenge heroloop_api.siws_challenges%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_request_id IS NULL
    OR p_nonce_hash IS NULL OR p_nonce_hash !~ '^[0-9a-f]{64}$'
    OR p_message_hash IS NULL OR p_message_hash !~ '^[0-9a-f]{64}$'
    OR p_wallet_hash IS NULL OR p_wallet_hash !~ '^[0-9a-f]{64}$'
    OR p_proof_valid IS NULL THEN
    RAISE EXCEPTION 'api_invalid_siws_challenge_attempt';
  END IF;

  SELECT * INTO v_challenge
  FROM heroloop_api.siws_challenges
  WHERE request_id = p_request_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_challenge.consumed_at IS NOT NULL
    OR v_challenge.expires_at <= v_now
    OR v_challenge.failed_attempts >= 5 THEN
    RETURN jsonb_build_object('consumed', false);
  END IF;

  -- Unknown hashes cannot spend another challenge's failure budget.
  IF v_challenge.nonce_hash <> p_nonce_hash
    OR v_challenge.message_hash <> p_message_hash
    OR v_challenge.wallet_hash <> p_wallet_hash THEN
    RETURN jsonb_build_object('consumed', false);
  END IF;

  IF NOT p_proof_valid THEN
    UPDATE heroloop_api.siws_challenges
    SET failed_attempts = LEAST(5, failed_attempts + 1)
    WHERE request_id = p_request_id;
    RETURN jsonb_build_object('consumed', false);
  END IF;

  UPDATE heroloop_api.siws_challenges
  SET consumed_at = v_now
  WHERE request_id = p_request_id;
  RETURN jsonb_build_object('consumed', true);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.consume_siws_challenge(uuid, text, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.consume_siws_challenge(uuid, text, text, text, boolean)
  TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.consume_siws_challenge(uuid, text, text, text, boolean) IS
  'Atomically locks and consumes one unexpired matching SIWS challenge; matching invalid proofs spend a five-attempt budget and every replay fails closed.';
