\set ON_ERROR_STOP on

ALTER TABLE heroloop_api.identity_events
  DROP CONSTRAINT IF EXISTS identity_events_event_kind_check,
  DROP CONSTRAINT IF EXISTS identity_events_result_code_check;
ALTER TABLE heroloop_api.identity_events
  ADD CONSTRAINT identity_events_event_kind_check
    CHECK (event_kind IN ('link', 'session_revoke', 'unlink', 'provider_revoke')),
  ADD CONSTRAINT identity_events_result_code_check
    CHECK (result_code IN (
      'linked', 'subject_collision', 'revoked', 'unlinked',
      'last_identity_rejected', 'recovery_locked'
    ));

CREATE OR REPLACE FUNCTION heroloop_api.unlink_siws_identity(
  p_account_id uuid,
  p_token_hash text,
  p_request_id uuid,
  p_provider_revoke boolean DEFAULT false
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
  v_other_active integer;
  v_result text;
BEGIN
  IF p_account_id IS NULL OR p_request_id IS NULL
    OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'api_invalid_identity_unlink';
  END IF;

  SELECT * INTO v_session
  FROM heroloop_api.siws_wallet_sessions
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND OR v_session.linked_account_id IS DISTINCT FROM p_account_id THEN
    RETURN jsonb_build_object('unlinked', false, 'code', 'invalid_wallet_session');
  END IF;

  SELECT * INTO v_identity
  FROM heroloop_api.account_identities
  WHERE account_id = p_account_id
    AND provider = 'solana'
    AND provider_subject = v_session.wallet_address
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('unlinked', false, 'code', 'identity_not_found');
  END IF;

  SELECT * INTO v_event
  FROM heroloop_api.identity_events
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_event.account_id = p_account_id
      AND v_event.identity_id = v_identity.identity_id
      AND v_event.event_kind = (CASE WHEN p_provider_revoke THEN 'provider_revoke' ELSE 'unlink' END) THEN
      RETURN jsonb_build_object(
        'unlinked', v_event.result_code IN ('unlinked', 'recovery_locked'),
        'replayed', true,
        'code', v_event.result_code,
        'account_state', CASE WHEN v_event.result_code = 'recovery_locked' THEN 'recovery_locked' ELSE 'active' END
      );
    END IF;
    RETURN jsonb_build_object('unlinked', false, 'code', 'request_conflict');
  END IF;

  IF v_session.revoked_at IS NOT NULL OR v_session.expires_at <= v_now THEN
    RETURN jsonb_build_object('unlinked', false, 'code', 'invalid_wallet_session');
  END IF;

  IF NOT public.consume_edge_rate_limit(
    p_account_id::text, 'siws_identity_unlink', 3, 300
  ) THEN
    RETURN jsonb_build_object('unlinked', false, 'code', 'rate_limited');
  END IF;

  SELECT count(*) INTO v_other_active
  FROM heroloop_api.account_identities
  WHERE account_id = p_account_id
    AND state = 'active'
    AND identity_id <> v_identity.identity_id;

  IF NOT p_provider_revoke AND v_identity.state = 'active' AND v_other_active = 0 THEN
    INSERT INTO heroloop_api.identity_events (
      account_id, identity_id, session_id, event_kind, provider,
      subject_hash, request_id, result_code
    ) VALUES (
      p_account_id, v_identity.identity_id, v_session.session_id, 'unlink',
      'solana', v_identity.subject_hash, p_request_id, 'last_identity_rejected'
    );
    RETURN jsonb_build_object('unlinked', false, 'code', 'last_identity');
  END IF;

  UPDATE heroloop_api.account_identities
  SET state = 'revoked', revoked_at = COALESCE(revoked_at, v_now)
  WHERE identity_id = v_identity.identity_id;
  UPDATE heroloop_api.siws_wallet_sessions
  SET revoked_at = COALESCE(revoked_at, v_now),
      revoked_reason = COALESCE(revoked_reason, 'expired_identity')
  WHERE wallet_address = v_identity.provider_subject;

  IF v_other_active = 0 THEN
    UPDATE heroloop_api.heroloop_accounts
    SET state = 'recovery_locked', updated_at = v_now
    WHERE account_id = p_account_id;
    v_result := 'recovery_locked';
  ELSE
    v_result := 'unlinked';
  END IF;

  INSERT INTO heroloop_api.identity_events (
    account_id, identity_id, session_id, event_kind, provider,
    subject_hash, request_id, result_code
  ) VALUES (
    p_account_id, v_identity.identity_id, v_session.session_id,
    CASE WHEN p_provider_revoke THEN 'provider_revoke' ELSE 'unlink' END,
    'solana', v_identity.subject_hash, p_request_id, v_result
  );

  RETURN jsonb_build_object(
    'unlinked', true, 'replayed', false, 'code', v_result,
    'account_state', CASE WHEN v_other_active = 0 THEN 'recovery_locked' ELSE 'active' END
  );
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.unlink_siws_identity(uuid, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.unlink_siws_identity(uuid, text, uuid, boolean)
  TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.unlink_siws_identity(uuid, text, uuid, boolean) IS
  'Requires recent wallet reauthentication, rejects last-identity unlink, revokes every matching provider session and recovery-locks a last-identity provider revocation.';
