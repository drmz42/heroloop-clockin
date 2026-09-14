\set ON_ERROR_STOP on

CREATE TABLE heroloop_api.account_auth_subjects (
  auth_subject uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL UNIQUE
    REFERENCES heroloop_api.account_identities(identity_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

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

  -- Serialize first-login creation for one verified wallet without exposing the subject.
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

CREATE OR REPLACE FUNCTION heroloop_api.resolve_authenticated_account(p_auth_subject uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_account_id uuid;
  v_identity_state text;
  v_account_state text;
BEGIN
  IF p_auth_subject IS NULL THEN
    RETURN jsonb_build_object('authenticated', false);
  END IF;
  SELECT identity.account_id, identity.state, account.state
  INTO v_account_id, v_identity_state, v_account_state
  FROM heroloop_api.account_auth_subjects subject
  JOIN heroloop_api.account_identities identity USING (identity_id)
  JOIN heroloop_api.heroloop_accounts account USING (account_id)
  WHERE subject.auth_subject = p_auth_subject;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('authenticated', true, 'account_id', p_auth_subject);
  END IF;
  IF v_identity_state <> 'active' OR v_account_state <> 'active' THEN
    RETURN jsonb_build_object('authenticated', false);
  END IF;
  RETURN jsonb_build_object('authenticated', true, 'account_id', v_account_id);
END
$function$;

REVOKE ALL ON TABLE heroloop_api.account_auth_subjects
  FROM PUBLIC, anon, authenticated, heroloop_api;
REVOKE ALL ON FUNCTION heroloop_api.bind_siws_account_login(uuid, text, uuid),
  heroloop_api.resolve_authenticated_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.bind_siws_account_login(uuid, text, uuid),
  heroloop_api.resolve_authenticated_account(uuid)
  TO heroloop_api;

COMMENT ON TABLE heroloop_api.account_auth_subjects IS
  'Server-only mapping from a verified provider Auth subject to one canonical HeroLoop account identity; contains no tokens or provider subject values.';
COMMENT ON FUNCTION heroloop_api.bind_siws_account_login(uuid, text, uuid) IS
  'Binds the internal GoTrue Web3 subject to the canonical account derived only from a freshly claimed SIWS wallet session.';
COMMENT ON FUNCTION heroloop_api.resolve_authenticated_account(uuid) IS
  'Resolves a validated GoTrue JWT subject to its canonical active HeroLoop account and fails closed for revoked mappings.';
