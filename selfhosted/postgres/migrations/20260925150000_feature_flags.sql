-- Staging feature flags (config/feature-flags.v1.json). Every flag is a kill
-- switch: on unless a founder turned it off, and while off the game API refuses
-- the commands that flag names before they touch state. A flag never enables a
-- feature, never grants or refunds anything, and has no row until its first
-- change, so an empty table means everything is running as deployed.
--
-- The state lives in public so the game reads it through one narrow function;
-- the change log lives in admin with the rest of the panel's append-only
-- records. Every rule is enforced in admin.feature_flag_set, in one
-- transaction: founder actor, written reason, expected revision, exact replay
-- returns the stored result and a changed replay fails.

CREATE TABLE IF NOT EXISTS public.feature_flags (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,47}$'),
  enabled boolean NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feature_flags FROM PUBLIC;

CREATE TABLE IF NOT EXISTS admin.feature_flag_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  flag_key text NOT NULL CHECK (flag_key ~ '^[a-z][a-z0-9_]{2,47}$'),
  before_enabled boolean NOT NULL,
  after_enabled boolean NOT NULL,
  revision integer NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  result jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS feature_flag_changes_key_idx ON admin.feature_flag_changes(flag_key, occurred_at DESC);
ALTER TABLE admin.feature_flag_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin.feature_flag_changes FROM PUBLIC;

-- The game's only read: which flags are off right now. Keys only.
CREATE OR REPLACE FUNCTION heroloop_api.feature_flags_paused()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('paused', coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb))
  FROM public.feature_flags WHERE NOT enabled;
$$;

-- Current state and the recent change history for the panel. A flag with no
-- row is reported by the BFF as on at revision 0.
CREATE OR REPLACE FUNCTION admin.feature_flag_list()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
  SELECT jsonb_build_object(
    'flags', coalesce((
      SELECT jsonb_agg(jsonb_build_object('key', f.key, 'enabled', f.enabled, 'revision', f.revision, 'updated_at', f.updated_at) ORDER BY f.key)
      FROM public.feature_flags f), '[]'::jsonb),
    'changes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'key', c.flag_key, 'before', c.before_enabled, 'after', c.after_enabled, 'revision', c.revision,
        'occurred_at', c.occurred_at, 'actor', i.email, 'reason', c.reason) ORDER BY c.occurred_at DESC)
      FROM (SELECT * FROM admin.feature_flag_changes ORDER BY occurred_at DESC LIMIT 50) c
      JOIN admin.identities i ON i.id = c.actor_identity_id), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION admin.feature_flag_set(
  p_actor uuid, p_key text, p_enabled boolean, p_expected_revision integer,
  p_reason text, p_idempotency_key uuid, p_fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, admin AS $$
DECLARE
  v_actor admin.identities%ROWTYPE;
  v_prior admin.feature_flag_changes%ROWTYPE;
  v_current boolean;
  v_revision integer;
  v_result jsonb;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO v_actor FROM admin.identities WHERE id = p_actor;
  IF NOT FOUND OR v_actor.role <> 'founder' OR v_actor.status <> 'active' THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{2,47}$' OR p_enabled IS NULL OR p_expected_revision IS NULL
     OR p_expected_revision < 0 OR p_idempotency_key IS NULL OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  -- One change per flag at a time; a replay waits for the original.
  PERFORM pg_advisory_xact_lock(hashtext('heroloop.feature_flag'), hashtext(p_key));

  SELECT * INTO v_prior FROM admin.feature_flag_changes WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.request_fingerprint <> p_fingerprint OR v_prior.actor_identity_id <> p_actor THEN
      RAISE EXCEPTION 'idempotency_key_reused_with_changed_request' USING ERRCODE = '22023';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  SELECT enabled, revision INTO v_current, v_revision FROM public.feature_flags WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    v_current := true;
    v_revision := 0;
  END IF;
  IF v_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;
  IF v_current = p_enabled THEN
    RAISE EXCEPTION 'no_change' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.feature_flags (key, enabled, revision, updated_at)
  VALUES (p_key, p_enabled, v_revision + 1, now())
  ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at;

  v_result := jsonb_build_object('key', p_key, 'enabled', p_enabled, 'before', v_current, 'revision', v_revision + 1, 'replayed', false);
  INSERT INTO admin.feature_flag_changes
    (idempotency_key, request_fingerprint, actor_identity_id, flag_key, before_enabled, after_enabled, revision, reason, result)
  VALUES (p_idempotency_key, p_fingerprint, p_actor, p_key, v_current, p_enabled, v_revision + 1, v_reason, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION heroloop_api.feature_flags_paused() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.feature_flag_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.feature_flag_set(uuid, text, boolean, integer, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.feature_flags_paused() TO heroloop_api;
GRANT EXECUTE ON FUNCTION admin.feature_flag_list() TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.feature_flag_set(uuid, text, boolean, integer, text, uuid, text) TO heroloop_admin;

-- A flag change is a founder write with a consequence for every player on the
-- environment, so it gets its own audit kind.
DO $audit_kinds$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname INTO v_constraint FROM pg_constraint
  WHERE conrelid = 'admin.audit_log'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_kind%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE admin.audit_log DROP CONSTRAINT %I', v_constraint);
  END IF;
  ALTER TABLE admin.audit_log ADD CONSTRAINT audit_log_event_kind_check CHECK (event_kind IN (
    'login_identity', 'login_passkey', 'passkey_enroll', 'step_up', 'view_access', 'allowlist_change',
    'player_search', 'player_view', 'player_unmask', 'support_note', 'player_operation',
    'analytics_export', 'account_deletion', 'notification_acknowledge', 'todo_action', 'feature_flag_change'
  ));
END
$audit_kinds$;
