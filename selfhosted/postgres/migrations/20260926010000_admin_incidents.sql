\set ON_ERROR_STOP on

-- Incidents and postmortems for the Founder Control Center
-- (docs/game/founder-control-center-v2-tz.md, "Incidents & postmortems").
--
-- An incident is a title, a severity and the environment it hit; everything
-- that happens to it afterwards is one more timeline row: an update, the
-- cause, the fix, resolved, reopened. Nothing is edited or deleted - the panel
-- role can only read these tables and write through the two functions below,
-- which a founder alone may call. Whether an incident is open is read from its
-- last resolved/reopened row, so there is no status column to drift.
--
-- The text is written by a person on a phone, not pasted from a terminal: an
-- address, an id, a wallet or a key has no business here, and the same shape
-- rules as the notification queue refuse them in the table itself. Raw logs
-- stay on the host; a line of one would trip the identifier rule anyway.

CREATE TABLE IF NOT EXISTS admin.incidents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid NOT NULL REFERENCES admin.identities(id),
  severity text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3')),
  environment text NOT NULL CHECK (environment IN ('staging', 'production', 'both', 'infrastructure')),
  title text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT incidents_title_length CHECK (char_length(title) BETWEEN 3 AND 120),
  CONSTRAINT incidents_title_carries_no_contact CHECK (position('@' IN title) = 0),
  CONSTRAINT incidents_title_carries_no_identifier CHECK (title !~ '[A-Za-z0-9]{26}')
);
CREATE INDEX IF NOT EXISTS incidents_opened_idx ON admin.incidents(opened_at DESC);

CREATE TABLE IF NOT EXISTS admin.incident_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES admin.incidents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  actor_role text NOT NULL CHECK (actor_role IN ('founder', 'operations_support', 'analyst')),
  kind text NOT NULL CHECK (kind IN ('opened', 'update', 'cause', 'fix', 'resolved', 'reopened')),
  body text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT incident_events_body_length CHECK (char_length(body) BETWEEN 3 AND 1000),
  CONSTRAINT incident_events_body_carries_no_contact CHECK (position('@' IN body) = 0),
  CONSTRAINT incident_events_body_carries_no_identifier CHECK (body !~ '[A-Za-z0-9]{26}')
);
CREATE INDEX IF NOT EXISTS incident_events_incident_idx ON admin.incident_events(incident_id, created_at, id);

COMMENT ON TABLE admin.incidents IS
  'Founder Control Center incidents: title, severity and affected environment; never edited or deleted, state comes from admin.incident_events.';
COMMENT ON TABLE admin.incident_events IS
  'Append-only incident timeline: opened, update, cause, fix, resolved, reopened. Text refuses addresses and identifier-shaped runs.';

-- Refusals are raised as plain codes the BFF maps to HTTP statuses.
CREATE OR REPLACE FUNCTION admin.incident_require_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND role = 'founder' AND status = 'active') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION admin.incident_check_text(p_text text, p_min integer, p_max integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_text text := btrim(coalesce(p_text, ''));
BEGIN
  IF char_length(v_text) NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION 'invalid_incident_text' USING ERRCODE = '22023';
  END IF;
  IF position('@' IN v_text) > 0 OR v_text ~ '[A-Za-z0-9]{26}' THEN
    RAISE EXCEPTION 'incident_text_carries_identifier' USING ERRCODE = '22023';
  END IF;
  RETURN v_text;
END
$function$;

-- Opens one incident with its first timeline row. A retry with the same key
-- returns the incident it already opened; the same key with other content is
-- refused rather than guessed at.
CREATE OR REPLACE FUNCTION admin.incident_open(
  p_actor uuid, p_severity text, p_environment text, p_title text, p_summary text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_existing admin.incidents%ROWTYPE;
  v_title text;
  v_summary text;
  v_id bigint;
BEGIN
  PERFORM admin.incident_require_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_severity IS NULL OR p_severity NOT IN ('sev1', 'sev2', 'sev3') THEN
    RAISE EXCEPTION 'invalid_incident_severity' USING ERRCODE = '22023';
  END IF;
  IF p_environment IS NULL OR p_environment NOT IN ('staging', 'production', 'both', 'infrastructure') THEN
    RAISE EXCEPTION 'invalid_incident_environment' USING ERRCODE = '22023';
  END IF;
  v_title := admin.incident_check_text(p_title, 3, 120);
  v_summary := admin.incident_check_text(p_summary, 3, 1000);

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.incidents'));
  SELECT * INTO v_existing FROM admin.incidents WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.title <> v_title OR v_existing.severity <> p_severity OR v_existing.environment <> p_environment THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM admin.incident_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.incidents(opened_by, severity, environment, title, idempotency_key)
  VALUES (p_actor, p_severity, p_environment, v_title, p_idempotency_key)
  RETURNING id INTO v_id;
  -- The opening row reuses nothing: its own key is derived so a retry of the
  -- open cannot collide with a later timeline write.
  INSERT INTO admin.incident_events(incident_id, actor_identity_id, actor_role, kind, body, idempotency_key)
  VALUES (v_id, p_actor, 'founder', 'opened', v_summary, gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

-- One more timeline row. Resolving needs an open incident and reopening a
-- resolved one; an update, cause or fix is welcome either way, because the
-- postmortem is usually written after the fire is out.
CREATE OR REPLACE FUNCTION admin.incident_record(
  p_actor uuid, p_incident_id bigint, p_kind text, p_body text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_existing admin.incident_events%ROWTYPE;
  v_body text;
  v_last_state text;
  v_id bigint;
BEGIN
  PERFORM admin.incident_require_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('update', 'cause', 'fix', 'resolved', 'reopened') THEN
    RAISE EXCEPTION 'invalid_incident_event' USING ERRCODE = '22023';
  END IF;
  v_body := admin.incident_check_text(p_body, 3, 1000);

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.incidents'));
  IF NOT EXISTS (SELECT 1 FROM admin.incidents WHERE id = p_incident_id) THEN
    RAISE EXCEPTION 'unknown_incident' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM admin.incident_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.incident_id <> p_incident_id OR v_existing.kind <> p_kind OR v_existing.body <> v_body THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'incident_id', p_incident_id, 'replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM admin.incidents WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
  END IF;

  SELECT kind INTO v_last_state FROM admin.incident_events
  WHERE incident_id = p_incident_id AND kind IN ('opened', 'resolved', 'reopened')
  ORDER BY created_at DESC, id DESC LIMIT 1;
  IF p_kind = 'resolved' AND v_last_state = 'resolved' THEN
    RAISE EXCEPTION 'incident_already_resolved' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'reopened' AND v_last_state IS DISTINCT FROM 'resolved' THEN
    RAISE EXCEPTION 'incident_not_resolved' USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.incident_events(incident_id, actor_identity_id, actor_role, kind, body, idempotency_key)
  VALUES (p_incident_id, p_actor, 'founder', p_kind, v_body, p_idempotency_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'incident_id', p_incident_id, 'replayed', false);
END
$function$;

-- Counts and the newest incidents with their whole timeline. The role, never
-- the person: who wrote each row is in the audit log.
CREATE OR REPLACE FUNCTION admin.incident_counts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  WITH state AS (
    SELECT i.id, i.severity, i.opened_at,
      (SELECT e.kind FROM admin.incident_events e
        WHERE e.incident_id = i.id AND e.kind IN ('opened', 'resolved', 'reopened')
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_state,
      (SELECT max(e.created_at) FROM admin.incident_events e
        WHERE e.incident_id = i.id AND e.kind = 'resolved') AS resolved_at
    FROM admin.incidents i
  )
  SELECT jsonb_build_object(
    'total', count(*),
    'open', count(*) FILTER (WHERE last_state <> 'resolved'),
    'open_sev1', count(*) FILTER (WHERE last_state <> 'resolved' AND severity = 'sev1'),
    'open_sev2', count(*) FILTER (WHERE last_state <> 'resolved' AND severity = 'sev2'),
    'open_sev3', count(*) FILTER (WHERE last_state <> 'resolved' AND severity = 'sev3'),
    'opened_30d', count(*) FILTER (WHERE opened_at >= now() - interval '30 days'),
    'resolved_30d', count(*) FILTER (WHERE last_state = 'resolved' AND resolved_at >= now() - interval '30 days'),
    'last_opened_at', max(opened_at)
  ) FROM state;
$function$;

CREATE OR REPLACE FUNCTION admin.incident_list(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT jsonb_build_object(
    'as_of', now(),
    'counts', admin.incident_counts(),
    'incidents', coalesce((
      SELECT jsonb_agg(item ORDER BY opened_at DESC, id DESC)
      FROM (
        SELECT i.id, i.opened_at, jsonb_build_object(
          'id', i.id,
          'opened_at', i.opened_at,
          'severity', i.severity,
          'environment', i.environment,
          'title', i.title,
          'status', CASE WHEN (
            SELECT e.kind FROM admin.incident_events e
            WHERE e.incident_id = i.id AND e.kind IN ('opened', 'resolved', 'reopened')
            ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'resolved' THEN 'resolved' ELSE 'open' END,
          'has_cause', EXISTS (SELECT 1 FROM admin.incident_events e WHERE e.incident_id = i.id AND e.kind = 'cause'),
          'has_fix', EXISTS (SELECT 1 FROM admin.incident_events e WHERE e.incident_id = i.id AND e.kind = 'fix'),
          'events', (
            SELECT jsonb_agg(jsonb_build_object(
              'id', e.id, 'created_at', e.created_at, 'kind', e.kind, 'body', e.body, 'actor_role', e.actor_role
            ) ORDER BY e.created_at, e.id)
            FROM admin.incident_events e WHERE e.incident_id = i.id
          )
        ) AS item
        FROM admin.incidents i
        ORDER BY i.opened_at DESC, i.id DESC
        LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
      ) newest
    ), '[]'::jsonb)
  );
$function$;

-- The Overview queue stops saying "not tracked" for incidents. Approvals still
-- have no table, so they keep saying so.
CREATE OR REPLACE FUNCTION admin.support_queue()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_levels jsonb;
  v_overdue bigint;
  v_next_deadline timestamptz;
  v_changes_7d bigint;
  v_notes_total bigint;
  v_notes_7d bigint;
  v_last_note timestamptz;
  v_operations_7d bigint;
  v_incidents jsonb;
BEGIN
  SELECT jsonb_build_object(
    'watch', count(*) FILTER (WHERE level = 'watch'),
    'review', count(*) FILTER (WHERE level = 'review'),
    'hold', count(*) FILTER (WHERE level = 'hold')
  ) INTO v_levels FROM public.account_risk_levels;

  SELECT count(*) FILTER (WHERE review_deadline < now()), min(review_deadline) FILTER (WHERE review_deadline >= now())
  INTO v_overdue, v_next_deadline
  FROM public.account_risk_levels;

  SELECT count(*) INTO v_changes_7d
  FROM public.account_risk_events WHERE created_at >= now() - interval '7 days';

  SELECT count(*), count(*) FILTER (WHERE created_at >= now() - interval '7 days'), max(created_at)
  INTO v_notes_total, v_notes_7d, v_last_note
  FROM admin.support_notes;

  SELECT count(*) INTO v_operations_7d
  FROM admin.player_operations WHERE created_at >= now() - interval '7 days';

  v_incidents := admin.incident_counts();

  RETURN jsonb_build_object(
    'as_of', now(),
    'risk_levels', v_levels,
    'risk_overdue_reviews', v_overdue,
    'risk_next_review_at', v_next_deadline,
    'risk_changes_7d', v_changes_7d,
    'support_notes_total', v_notes_total,
    'support_notes_7d', v_notes_7d,
    'support_last_note_at', v_last_note,
    'support_operations_7d', v_operations_7d,
    'incidents', jsonb_build_object(
      'open', v_incidents->'open',
      'open_sev1', v_incidents->'open_sev1',
      'last_opened_at', v_incidents->'last_opened_at'
    ),
    'approvals', 'not_tracked'
  );
END
$function$;

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
    'analytics_export', 'account_deletion', 'notification_acknowledge', 'todo_action', 'feature_flag_change',
    'simulation_run', 'incident_record'
  ));
END
$audit_kinds$;

-- Append-only by privilege: the panel role reads both tables and writes only
-- through the founder-checked functions.
REVOKE ALL ON admin.incidents, admin.incident_events FROM PUBLIC;
GRANT SELECT ON admin.incidents, admin.incident_events TO heroloop_admin;

REVOKE ALL ON FUNCTION admin.incident_require_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_check_text(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_open(uuid, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_list(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.incident_open(uuid, text, text, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.incident_list(integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.support_queue() TO heroloop_admin;

COMMENT ON FUNCTION admin.incident_open(uuid, text, text, text, text, uuid) IS
  'Founder only: opens one incident with its first timeline row; idempotent by key.';
COMMENT ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid) IS
  'Founder only: appends update, cause, fix, resolved or reopened to one incident; idempotent by key.';
COMMENT ON FUNCTION admin.incident_list(integer) IS
  'Incident counts and the newest incidents with their timelines; role, never person.';
COMMENT ON FUNCTION admin.support_queue() IS
  'Aggregate-only support and risk queue for the Founder Control Center Overview: counts and deadlines, never a player id, note or reason; incidents as open counts.';
