-- Roles and delegation (docs/game/admin-access-governance-proposal.md,
-- config/admin-access-governance.v1.json). A founder invites a person with one
-- of the three fixed roles, changes a role, suspends, reactivates or removes an
-- identity. Every rule is enforced here, in one transaction, so the BFF cannot
-- skip one: founder actor only, no change to oneself, never lose the last
-- active founder, target revision must match, exact replay returns the stored
-- result, a changed replay fails. Role change, suspension and removal revoke
-- every session of the target. The change log is append-only.

ALTER TABLE admin.identities ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
-- When an invitation was issued. An invitation is good for 15 minutes: a
-- pending identity whose invitation is older cannot sign in and must be
-- invited again. NULL for identities that predate invitations.
ALTER TABLE admin.identities ADD COLUMN IF NOT EXISTS invited_at timestamptz;

CREATE TABLE IF NOT EXISTS admin.access_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  target_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  action text NOT NULL CHECK (action IN ('invite', 'change_role', 'suspend', 'reactivate', 'remove')),
  before_state jsonb,
  after_state jsonb NOT NULL,
  sessions_revoked integer NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  result jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS access_changes_target_idx ON admin.access_changes(target_identity_id, occurred_at DESC);
ALTER TABLE admin.access_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin.access_changes FROM PUBLIC;
-- Read only through admin.access_member_log; written only by admin.access_apply.

-- What a change would do, without doing it. Returns the refusal code when a
-- rule forbids it, so the screen can show why before anyone confirms.
CREATE OR REPLACE FUNCTION admin.access_preview(
  p_actor uuid, p_email text, p_action text, p_role text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_actor admin.identities%ROWTYPE;
  v_target admin.identities%ROWTYPE;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_after jsonb;
  v_before jsonb;
  v_founders integer;
  v_refusal text;
  v_sessions integer := 0;
  v_exists boolean;
BEGIN
  SELECT * INTO v_actor FROM admin.identities WHERE id = p_actor;
  IF NOT FOUND OR v_actor.role <> 'founder' OR v_actor.status <> 'active' THEN
    RETURN jsonb_build_object('refusal', 'founder_role_required');
  END IF;
  IF p_action NOT IN ('invite', 'change_role', 'suspend', 'reactivate', 'remove') THEN
    RETURN jsonb_build_object('refusal', 'invalid_action');
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254 THEN
    RETURN jsonb_build_object('refusal', 'invalid_email');
  END IF;
  IF p_action IN ('invite', 'change_role') AND coalesce(p_role, '') NOT IN ('founder', 'operations_support', 'analyst') THEN
    RETURN jsonb_build_object('refusal', 'invalid_role');
  END IF;

  SELECT * INTO v_target FROM admin.identities WHERE email = v_email;
  v_exists := FOUND;
  IF v_exists THEN
    v_before := jsonb_build_object('email', v_target.email, 'role', v_target.role, 'status', v_target.status, 'revision', v_target.revision);
    SELECT count(*) INTO v_sessions FROM admin.sessions
    WHERE identity_id = v_target.id AND revoked_at IS NULL AND expires_at > now();
  END IF;
  IF v_exists AND v_target.id = p_actor THEN
    RETURN jsonb_build_object('refusal', 'self_change_forbidden', 'before', v_before);
  END IF;

  SELECT count(*) INTO v_founders FROM admin.identities WHERE role = 'founder' AND status = 'active';

  IF p_action = 'invite' THEN
    IF v_exists AND v_target.status <> 'removed' THEN
      v_refusal := 'already_on_allowlist';
    END IF;
    v_after := jsonb_build_object('email', v_email, 'role', p_role, 'status', 'pending');
  ELSIF NOT v_exists THEN
    RETURN jsonb_build_object('refusal', 'unknown_identity');
  ELSIF p_action = 'change_role' THEN
    IF v_target.status NOT IN ('pending', 'active', 'suspended') THEN v_refusal := 'identity_removed';
    ELSIF v_target.role = p_role THEN v_refusal := 'no_change';
    ELSIF v_target.role = 'founder' AND v_target.status = 'active' AND v_founders <= 1 THEN v_refusal := 'last_founder';
    END IF;
    v_after := v_before || jsonb_build_object('role', p_role);
  ELSIF p_action = 'suspend' THEN
    IF v_target.status NOT IN ('pending', 'active') THEN v_refusal := 'not_active';
    ELSIF v_target.role = 'founder' AND v_target.status = 'active' AND v_founders <= 1 THEN v_refusal := 'last_founder';
    END IF;
    v_after := v_before || jsonb_build_object('status', 'suspended');
  ELSIF p_action = 'reactivate' THEN
    IF v_target.status <> 'suspended' THEN v_refusal := 'not_suspended'; END IF;
    v_after := v_before || jsonb_build_object('status', 'active');
  ELSIF p_action = 'remove' THEN
    IF v_target.status = 'removed' THEN v_refusal := 'already_removed';
    ELSIF v_target.role = 'founder' AND v_target.status = 'active' AND v_founders <= 1 THEN v_refusal := 'last_founder';
    END IF;
    v_after := v_before || jsonb_build_object('status', 'removed');
  END IF;

  RETURN jsonb_build_object(
    'refusal', v_refusal,
    'before', v_before,
    'after', v_after,
    'target_revision', CASE WHEN v_before IS NULL THEN NULL ELSE v_target.revision END,
    'sessions_to_revoke', CASE WHEN p_action IN ('change_role', 'suspend', 'remove') THEN v_sessions ELSE 0 END,
    'expands_access', p_action IN ('invite', 'reactivate')
      OR (p_action = 'change_role' AND (p_role = 'founder' OR (p_role = 'operations_support' AND v_target.role = 'analyst')))
  );
END
$$;

CREATE OR REPLACE FUNCTION admin.access_apply(
  p_actor uuid, p_email text, p_action text, p_role text, p_reason text,
  p_idempotency_key uuid, p_fingerprint text, p_expected_revision integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_prior admin.access_changes%ROWTYPE;
  v_preview jsonb;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_target admin.identities%ROWTYPE;
  v_revoked integer := 0;
  v_result jsonb;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;
  -- Serialise every access change: the last-founder rule reads other rows.
  PERFORM pg_advisory_xact_lock(hashtext('admin.access_apply'));

  SELECT * INTO v_prior FROM admin.access_changes WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.request_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'idempotency_key_reused_with_changed_request' USING ERRCODE = '22023';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  v_preview := admin.access_preview(p_actor, v_email, p_action, p_role);
  IF v_preview->>'refusal' IS NOT NULL THEN
    RAISE EXCEPTION '%', v_preview->>'refusal' USING ERRCODE = '22023';
  END IF;
  IF (v_preview->>'target_revision')::integer IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;

  IF p_action = 'invite' THEN
    INSERT INTO admin.identities(email, role, status, invited_at)
    VALUES (v_email, p_role, 'pending', now())
    ON CONFLICT (email) DO UPDATE
      SET role = excluded.role, status = 'pending', invited_at = now(), updated_at = now(), revision = admin.identities.revision + 1
    RETURNING * INTO v_target;
    -- A removed identity coming back starts with no authenticator.
    DELETE FROM admin.passkeys WHERE identity_id = v_target.id;
  ELSE
    UPDATE admin.identities SET
      role = CASE WHEN p_action = 'change_role' THEN p_role ELSE role END,
      status = CASE p_action WHEN 'suspend' THEN 'suspended' WHEN 'reactivate' THEN 'active' WHEN 'remove' THEN 'removed' ELSE status END,
      updated_at = now(),
      revision = revision + 1
    WHERE email = v_email
    RETURNING * INTO v_target;
    IF p_action IN ('change_role', 'suspend', 'remove') THEN
      UPDATE admin.sessions SET revoked_at = now() WHERE identity_id = v_target.id AND revoked_at IS NULL;
      GET DIAGNOSTICS v_revoked = ROW_COUNT;
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'action', p_action,
    'identity_id', v_target.id,
    'before', v_preview->'before',
    'after', jsonb_build_object('email', v_target.email, 'role', v_target.role, 'status', v_target.status, 'revision', v_target.revision),
    'sessions_revoked', v_revoked,
    'replayed', false
  );
  INSERT INTO admin.access_changes(idempotency_key, request_fingerprint, actor_identity_id, target_identity_id, action,
    before_state, after_state, sessions_revoked, reason, result)
  VALUES (p_idempotency_key, p_fingerprint, p_actor, v_target.id, p_action,
    v_preview->'before', v_result->'after', v_revoked, btrim(p_reason), v_result);
  RETURN v_result;
END
$$;

-- The team as the founder sees it: staff identities only (never players), with
-- what each can do right now and when they last did anything.
CREATE OR REPLACE FUNCTION admin.access_members()
RETURNS TABLE (
  identity_id uuid, email text, role text, status text, revision integer,
  invited_at timestamptz, invitation_expired boolean, created_at timestamptz,
  last_seen_at timestamptz, active_sessions integer, passkeys integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT i.id, i.email, i.role, i.status, i.revision, i.invited_at,
    i.status = 'pending' AND i.invited_at IS NOT NULL AND i.invited_at < now() - interval '15 minutes',
    i.created_at,
    (SELECT max(s.last_seen_at) FROM admin.sessions s WHERE s.identity_id = i.id),
    (SELECT count(*)::integer FROM admin.sessions s WHERE s.identity_id = i.id AND s.revoked_at IS NULL AND s.expires_at > now()),
    (SELECT count(*)::integer FROM admin.passkeys p WHERE p.identity_id = i.id)
  FROM admin.identities i
  ORDER BY CASE i.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, i.email
$$;

-- One member's own actions from the audit log, plus the access changes made
-- to them. Reasons are the server-authored audit text, never a token.
CREATE OR REPLACE FUNCTION admin.access_member_log(p_identity uuid, p_limit integer)
RETURNS TABLE (occurred_at timestamptz, source text, kind text, outcome text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT * FROM (
    SELECT a.occurred_at, 'action'::text, a.event_kind, a.outcome, a.reason
    FROM admin.audit_log a WHERE a.actor_identity_id = p_identity
    UNION ALL
    SELECT c.occurred_at, 'access_change'::text, c.action, 'success'::text,
      coalesce(c.before_state->>'role', '—') || '/' || coalesce(c.before_state->>'status', 'new') || ' -> '
        || (c.after_state->>'role') || '/' || (c.after_state->>'status') || ': ' || c.reason
    FROM admin.access_changes c WHERE c.target_identity_id = p_identity
  ) rows
  ORDER BY 1 DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

REVOKE ALL ON FUNCTION admin.access_preview(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.access_apply(uuid, text, text, text, text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.access_members() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.access_member_log(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.access_preview(uuid, text, text, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.access_apply(uuid, text, text, text, text, uuid, text, integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.access_members() TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.access_member_log(uuid, integer) TO heroloop_admin;
