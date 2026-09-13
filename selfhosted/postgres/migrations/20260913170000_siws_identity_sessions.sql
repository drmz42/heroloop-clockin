\set ON_ERROR_STOP on

CREATE TABLE heroloop_api.heroloop_accounts (
  account_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'recovery_locked', 'deletion_pending')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE heroloop_api.account_identities (
  identity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES heroloop_api.heroloop_accounts(account_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('solana', 'google', 'apple', 'steam')),
  provider_subject text NOT NULL,
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (provider, provider_subject),
  UNIQUE (provider, subject_hash)
);

CREATE INDEX account_identities_account_idx
  ON heroloop_api.account_identities (account_id, state, provider);

CREATE TABLE heroloop_api.identity_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES heroloop_api.heroloop_accounts(account_id) ON DELETE CASCADE,
  identity_id uuid REFERENCES heroloop_api.account_identities(identity_id) ON DELETE SET NULL,
  session_id uuid REFERENCES heroloop_api.siws_wallet_sessions(session_id) ON DELETE SET NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('link', 'session_revoke')),
  provider text NOT NULL CHECK (provider IN ('solana', 'google', 'apple', 'steam')),
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL UNIQUE,
  result_code text NOT NULL CHECK (result_code IN ('linked', 'subject_collision', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE heroloop_api.siws_wallet_sessions
  ADD COLUMN linked_account_id uuid REFERENCES heroloop_api.heroloop_accounts(account_id) ON DELETE SET NULL,
  ADD COLUMN revoked_reason text CHECK (revoked_reason IN ('logout', 'wallet_disconnect', 'account_change', 'expired_identity'));

CREATE INDEX siws_wallet_sessions_account_idx
  ON heroloop_api.siws_wallet_sessions (linked_account_id, expires_at DESC)
  WHERE linked_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION heroloop_api.link_siws_wallet_session(
  p_account_id uuid,
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
  v_event heroloop_api.identity_events%ROWTYPE;
  v_allowed boolean;
BEGIN
  IF p_account_id IS NULL OR p_request_id IS NULL
    OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'api_invalid_identity_link';
  END IF;

  SELECT * INTO v_session
  FROM heroloop_api.siws_wallet_sessions
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('linked', false, 'code', 'invalid_wallet_session');
  END IF;

  SELECT * INTO v_event
  FROM heroloop_api.identity_events
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_event.event_kind = 'link' AND v_event.account_id = p_account_id
      AND v_event.session_id = v_session.session_id
      AND v_event.result_code = 'linked' THEN
      SELECT * INTO v_identity
      FROM heroloop_api.account_identities
      WHERE identity_id = v_event.identity_id;
      RETURN jsonb_build_object(
        'linked', true, 'replayed', true, 'account_id', v_event.account_id,
        'identity_id', v_event.identity_id, 'address', v_identity.provider_subject
      );
    END IF;
    RETURN jsonb_build_object('linked', false, 'code', 'request_conflict');
  END IF;

  IF v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now THEN
    RETURN jsonb_build_object('linked', false, 'code', 'invalid_wallet_session');
  END IF;

  v_allowed := public.consume_edge_rate_limit(
    p_account_id::text, 'siws_identity_link', 5, 300
  );
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('linked', false, 'code', 'rate_limited');
  END IF;
  IF v_session.linked_account_id IS NOT NULL
    AND v_session.linked_account_id <> p_account_id THEN
    RETURN jsonb_build_object('linked', false, 'code', 'identity_collision');
  END IF;

  INSERT INTO heroloop_api.heroloop_accounts (account_id)
  VALUES (p_account_id)
  ON CONFLICT (account_id) DO UPDATE
    SET updated_at = EXCLUDED.updated_at;

  INSERT INTO heroloop_api.account_identities (
    account_id, provider, provider_subject, subject_hash
  ) VALUES (
    p_account_id, 'solana', v_session.wallet_address, v_session.wallet_hash
  )
  ON CONFLICT (provider, provider_subject) DO NOTHING;

  SELECT * INTO v_identity
  FROM heroloop_api.account_identities
  WHERE provider = 'solana' AND provider_subject = v_session.wallet_address
  FOR UPDATE;

  IF NOT FOUND OR v_identity.identity_id IS NULL THEN
    INSERT INTO heroloop_api.identity_events (
      account_id, session_id, event_kind, provider, subject_hash, request_id, result_code
    ) VALUES (
      p_account_id, v_session.session_id, 'link', 'solana', v_session.wallet_hash,
      p_request_id, 'subject_collision'
    );
    RETURN jsonb_build_object('linked', false, 'code', 'identity_collision');
  END IF;

  IF v_identity.account_id <> p_account_id THEN
    INSERT INTO heroloop_api.identity_events (
      account_id, identity_id, session_id, event_kind, provider, subject_hash, request_id, result_code
    ) VALUES (
      p_account_id, v_identity.identity_id, v_session.session_id, 'link', 'solana', v_session.wallet_hash,
      p_request_id, 'subject_collision'
    );
    RETURN jsonb_build_object('linked', false, 'code', 'identity_collision');
  END IF;

  UPDATE heroloop_api.account_identities
  SET state = 'active', last_verified_at = v_now, revoked_at = NULL
  WHERE identity_id = v_identity.identity_id;
  UPDATE heroloop_api.siws_wallet_sessions
  SET linked_account_id = p_account_id
  WHERE session_id = v_session.session_id;
  INSERT INTO heroloop_api.identity_events (
    account_id, identity_id, session_id, event_kind, provider, subject_hash, request_id, result_code
  ) VALUES (
    p_account_id, v_identity.identity_id, v_session.session_id, 'link', 'solana', v_session.wallet_hash,
    p_request_id, 'linked'
  );

  RETURN jsonb_build_object(
    'linked', true, 'replayed', false, 'account_id', p_account_id,
    'identity_id', v_identity.identity_id, 'address', v_session.wallet_address
  );
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.revoke_siws_wallet_session(
  p_token_hash text,
  p_request_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_session heroloop_api.siws_wallet_sessions%ROWTYPE;
  v_identity_id uuid;
BEGIN
  IF p_request_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
    OR p_reason NOT IN ('logout', 'wallet_disconnect', 'account_change', 'expired_identity') THEN
    RAISE EXCEPTION 'api_invalid_session_revoke';
  END IF;

  SELECT * INTO v_session
  FROM heroloop_api.siws_wallet_sessions
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('revoked', false); END IF;

  UPDATE heroloop_api.siws_wallet_sessions
  SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
      revoked_reason = COALESCE(revoked_reason, p_reason)
  WHERE session_id = v_session.session_id;

  IF v_session.linked_account_id IS NOT NULL THEN
    SELECT identity_id INTO v_identity_id
    FROM heroloop_api.account_identities
    WHERE account_id = v_session.linked_account_id
      AND provider = 'solana' AND provider_subject = v_session.wallet_address;
    INSERT INTO heroloop_api.identity_events (
      account_id, identity_id, session_id, event_kind, provider, subject_hash, request_id, result_code
    ) VALUES (
      v_session.linked_account_id, v_identity_id, v_session.session_id, 'session_revoke', 'solana',
      v_session.wallet_hash, p_request_id, 'revoked'
    ) ON CONFLICT (request_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('revoked', true);
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
  WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN jsonb_build_object('valid', false); END IF;
  RETURN jsonb_build_object(
    'valid', true, 'address', v_session.wallet_address,
    'expires_at', v_session.expires_at, 'account_id', v_session.linked_account_id
  );
END
$function$;

REVOKE ALL ON TABLE heroloop_api.heroloop_accounts,
  heroloop_api.account_identities, heroloop_api.identity_events
  FROM PUBLIC, anon, authenticated, heroloop_api;
REVOKE ALL ON FUNCTION heroloop_api.link_siws_wallet_session(uuid, text, uuid),
  heroloop_api.revoke_siws_wallet_session(text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.link_siws_wallet_session(uuid, text, uuid),
  heroloop_api.revoke_siws_wallet_session(text, uuid, text)
  TO heroloop_api;

COMMENT ON TABLE heroloop_api.identity_events IS
  'Append-only identity security audit: request/result metadata and HMAC subject only; no token, proof, nonce, email or raw provider subject.';
COMMENT ON FUNCTION heroloop_api.link_siws_wallet_session(uuid, text, uuid) IS
  'Atomically binds a fresh SIWS wallet session to the authenticated HeroLoop account and rejects cross-account subject collisions.';
