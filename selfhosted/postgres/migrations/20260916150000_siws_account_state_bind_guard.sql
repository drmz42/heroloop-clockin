\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.bind_siws_account_login(
  p_auth_subject uuid,
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
  v_identity heroloop_api.account_identities%ROWTYPE;
  v_account_state text;
  v_subject_identity_id uuid;
  v_identity_subject uuid;
BEGIN
  IF p_auth_subject IS NULL OR p_request_id IS NULL
    OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'api_invalid_account_login_bind';
  END IF;

  SELECT * INTO v_session
  FROM heroloop_api.siws_wallet_sessions
  WHERE token_hash = p_token_hash
    AND account_login_request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND OR v_session.account_login_claimed_at IS NULL
    OR v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now THEN
    RETURN jsonb_build_object('linked', false, 'code', 'invalid_wallet_session');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_session.wallet_hash, 0));
  SELECT * INTO v_identity
  FROM heroloop_api.account_identities
  WHERE provider = 'solana' AND provider_subject = v_session.wallet_address
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO heroloop_api.heroloop_accounts (account_id)
    VALUES (p_auth_subject)
    ON CONFLICT (account_id) DO UPDATE SET updated_at = EXCLUDED.updated_at;
    INSERT INTO heroloop_api.account_identities (
      account_id, provider, provider_subject, subject_hash
    ) VALUES (
      p_auth_subject, 'solana', v_session.wallet_address, v_session.wallet_hash
    );
    SELECT * INTO v_identity
    FROM heroloop_api.account_identities
    WHERE provider = 'solana' AND provider_subject = v_session.wallet_address
    FOR UPDATE;
  END IF;

  IF v_identity.state <> 'active' THEN
    RETURN jsonb_build_object('linked', false, 'code', 'identity_revoked');
  END IF;

  SELECT state INTO v_account_state
  FROM heroloop_api.heroloop_accounts
  WHERE account_id = v_identity.account_id
  FOR UPDATE;
  IF NOT FOUND OR v_account_state IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('linked', false, 'code', 'account_locked');
  END IF;

  IF v_identity.account_id <> p_auth_subject AND EXISTS (
    SELECT 1 FROM heroloop_api.heroloop_accounts
    WHERE account_id = p_auth_subject
  ) THEN
    RETURN jsonb_build_object('linked', false, 'code', 'subject_collision');
  END IF;

  SELECT identity_id INTO v_subject_identity_id
  FROM heroloop_api.account_auth_subjects
  WHERE auth_subject = p_auth_subject
  FOR UPDATE;
  IF FOUND AND v_subject_identity_id <> v_identity.identity_id THEN
    RETURN jsonb_build_object('linked', false, 'code', 'subject_collision');
  END IF;

  SELECT auth_subject INTO v_identity_subject
  FROM heroloop_api.account_auth_subjects
  WHERE identity_id = v_identity.identity_id
  FOR UPDATE;
  IF FOUND AND v_identity_subject <> p_auth_subject THEN
    RETURN jsonb_build_object('linked', false, 'code', 'subject_collision');
  END IF;

  INSERT INTO heroloop_api.account_auth_subjects (auth_subject, identity_id)
  VALUES (p_auth_subject, v_identity.identity_id)
  ON CONFLICT DO NOTHING;

  SELECT identity_id INTO v_subject_identity_id
  FROM heroloop_api.account_auth_subjects
  WHERE auth_subject = p_auth_subject;
  SELECT auth_subject INTO v_identity_subject
  FROM heroloop_api.account_auth_subjects
  WHERE identity_id = v_identity.identity_id;
  IF v_subject_identity_id IS DISTINCT FROM v_identity.identity_id
    OR v_identity_subject IS DISTINCT FROM p_auth_subject THEN
    RETURN jsonb_build_object('linked', false, 'code', 'subject_collision');
  END IF;

  UPDATE heroloop_api.siws_wallet_sessions
  SET linked_account_id = v_identity.account_id
  WHERE session_id = v_session.session_id;

  RETURN jsonb_build_object(
    'linked', true,
    'account_id', v_identity.account_id,
    'auth_subject', p_auth_subject,
    'address', v_identity.provider_subject
  );
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.bind_siws_account_login(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.bind_siws_account_login(uuid, text, uuid)
  TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.bind_siws_account_login(uuid, text, uuid) IS
  'Binds an internal GoTrue Web3 subject only to an active canonical account derived from a freshly claimed SIWS wallet session.';
