\set ON_ERROR_STOP on

-- Incidents, second pass: the postmortem becomes a gate, the fix can name the
-- commit that carried it, the log can be searched, and a serious incident
-- reaches the Founder's phone through the existing notification queue.
--
-- 1. Three more timeline kinds make the postmortem structured instead of one
--    free-text row: impact (who and what was hurt, for how long), lesson and
--    action (a follow-up task). Duration is not typed in: it is the time from
--    the opening row to the resolving one.
-- 2. An incident is resolved only once its cause, fix and impact are written.
--    Rows added after resolving are still welcome; the gate is on closing.
-- 3. A timeline row may carry one full commit SHA in its own column. The text
--    keeps refusing identifier-shaped runs, so the SHA is the only long token
--    that gets in, and only in the exact 40-hex shape.
-- 4. admin.incident_search filters by text, period and status and pages by id;
--    admin.incident_list stays as the unfiltered first page.
-- 5. Opening or reopening a SEV1/SEV2 incident records one notification under
--    the existing 'alerts' source, which the root-side dispatcher delivers.
--    Nothing here sends anything itself.

DO $kinds$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname INTO v_constraint FROM pg_constraint
  WHERE conrelid = 'admin.incident_events'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%kind%' AND pg_get_constraintdef(oid) ILIKE '%reopened%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE admin.incident_events DROP CONSTRAINT %I', v_constraint);
  END IF;
  ALTER TABLE admin.incident_events ADD CONSTRAINT incident_events_kind_check CHECK (kind IN (
    'opened', 'update', 'cause', 'fix', 'impact', 'lesson', 'action', 'resolved', 'reopened'
  ));
END
$kinds$;

ALTER TABLE admin.incident_events ADD COLUMN IF NOT EXISTS commit_sha text;
DO $sha$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'admin.incident_events'::regclass AND conname = 'incident_events_commit_sha_shape') THEN
    ALTER TABLE admin.incident_events ADD CONSTRAINT incident_events_commit_sha_shape
      CHECK (commit_sha IS NULL OR (commit_sha ~ '^[0-9a-f]{40}$' AND kind <> 'opened'));
  END IF;
END
$sha$;

COMMENT ON TABLE admin.incident_events IS
  'Append-only incident timeline: opened, update, cause, fix, impact, lesson, action, resolved, reopened. Text refuses addresses and identifier-shaped runs; a full commit SHA lives only in commit_sha.';

-- The notification a serious incident leaves in the queue. The text is built
-- from the already-checked title, so it satisfies the queue's own shape rules.
CREATE OR REPLACE FUNCTION admin.incident_notify(p_incident_id bigint, p_what text, p_dedupe_suffix text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_incident admin.incidents%ROWTYPE;
  v_where text;
BEGIN
  SELECT * INTO v_incident FROM admin.incidents WHERE id = p_incident_id;
  IF NOT FOUND OR v_incident.severity NOT IN ('sev1', 'sev2') THEN
    RETURN;
  END IF;
  v_where := CASE v_incident.environment
    WHEN 'staging' THEN 'Staging'
    WHEN 'production' THEN 'Production'
    WHEN 'both' THEN 'Staging and Production'
    ELSE 'infrastructure' END;
  PERFORM admin.notification_record(
    'alerts',
    CASE WHEN v_incident.severity = 'sev1' THEN 'critical' ELSE 'warning' END,
    'incident:' || p_incident_id || ':' || p_dedupe_suffix,
    'Incident ' || upper(v_incident.severity) || ' ' || p_what,
    '#' || p_incident_id || ' · ' || v_where || ': ' || v_incident.title,
    0.25
  );
END
$function$;

-- Same contract as before, plus the notification.
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
  INSERT INTO admin.incident_events(incident_id, actor_identity_id, actor_role, kind, body, idempotency_key)
  VALUES (v_id, p_actor, 'founder', 'opened', v_summary, gen_random_uuid());
  PERFORM admin.incident_notify(v_id, 'opened', 'opened');
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

-- One more timeline row, optionally naming a commit. Resolving needs an open
-- incident whose cause, fix and impact are already written.
CREATE OR REPLACE FUNCTION admin.incident_record(
  p_actor uuid, p_incident_id bigint, p_kind text, p_body text, p_idempotency_key uuid, p_commit_sha text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_existing admin.incident_events%ROWTYPE;
  v_body text;
  v_sha text := nullif(lower(btrim(coalesce(p_commit_sha, ''))), '');
  v_last_state text;
  v_id bigint;
BEGIN
  PERFORM admin.incident_require_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('update', 'cause', 'fix', 'impact', 'lesson', 'action', 'resolved', 'reopened') THEN
    RAISE EXCEPTION 'invalid_incident_event' USING ERRCODE = '22023';
  END IF;
  IF v_sha IS NOT NULL AND v_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'invalid_commit_sha' USING ERRCODE = '22023';
  END IF;
  v_body := admin.incident_check_text(p_body, 3, 1000);

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.incidents'));
  IF NOT EXISTS (SELECT 1 FROM admin.incidents WHERE id = p_incident_id) THEN
    RAISE EXCEPTION 'unknown_incident' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM admin.incident_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.incident_id <> p_incident_id OR v_existing.kind <> p_kind OR v_existing.body <> v_body
       OR v_existing.commit_sha IS DISTINCT FROM v_sha THEN
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
  IF p_kind = 'resolved' AND (
    SELECT count(DISTINCT kind) FROM admin.incident_events
    WHERE incident_id = p_incident_id AND kind IN ('cause', 'fix', 'impact')
  ) < 3 THEN
    RAISE EXCEPTION 'incident_postmortem_incomplete' USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.incident_events(incident_id, actor_identity_id, actor_role, kind, body, idempotency_key, commit_sha)
  VALUES (p_incident_id, p_actor, 'founder', p_kind, v_body, p_idempotency_key, v_sha)
  RETURNING id INTO v_id;
  IF p_kind = 'reopened' THEN
    PERFORM admin.incident_notify(p_incident_id, 'reopened', 'reopened:' || v_id);
  END IF;
  RETURN jsonb_build_object('id', v_id, 'incident_id', p_incident_id, 'replayed', false);
END
$function$;

-- The five-argument form is what an already-running panel calls until the new
-- one is installed; it now goes through the same gates.
CREATE OR REPLACE FUNCTION admin.incident_record(
  p_actor uuid, p_incident_id bigint, p_kind text, p_body text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT admin.incident_record(p_actor, p_incident_id, p_kind, p_body, p_idempotency_key, NULL::text);
$function$;

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
    -- Opening to the latest resolve, for incidents resolved inside 30 days.
    'median_minutes_to_resolve_30d', round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - opened_at))
      FILTER (WHERE last_state = 'resolved' AND resolved_at >= now() - interval '30 days') / 60)::numeric),
    'last_opened_at', max(opened_at)
  ) FROM state;
$function$;

-- Filtered, paged log. Text matches the title or any timeline row, or an exact
-- "#id"; the period applies to the opening time; paging continues below the
-- last id shown.
CREATE OR REPLACE FUNCTION admin.incident_search(
  p_limit integer DEFAULT 50,
  p_query text DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_until timestamptz DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_before_id bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_id_query bigint;
  v_items jsonb;
  v_found integer;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'invalid_incident_filter' USING ERRCODE = '22023';
  END IF;
  IF v_query IS NOT NULL THEN
    IF char_length(v_query) > 80 THEN
      RAISE EXCEPTION 'invalid_incident_filter' USING ERRCODE = '22023';
    END IF;
    IF v_query ~ '^#?[0-9]{1,18}$' THEN
      v_id_query := ltrim(v_query, '#')::bigint;
    END IF;
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  WITH base AS (
    SELECT i.*,
      (SELECT e.kind FROM admin.incident_events e
        WHERE e.incident_id = i.id AND e.kind IN ('opened', 'resolved', 'reopened')
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_state
    FROM admin.incidents i
    WHERE (p_before_id IS NULL OR i.id < p_before_id)
      AND (p_since IS NULL OR i.opened_at >= p_since)
      AND (p_until IS NULL OR i.opened_at < p_until)
      AND (v_query IS NULL
        OR i.id = v_id_query
        OR i.title ILIKE v_pattern
        OR EXISTS (SELECT 1 FROM admin.incident_events e WHERE e.incident_id = i.id AND (e.body ILIKE v_pattern OR (v_query ~ '^[0-9a-fA-F]{7,40}$' AND e.commit_sha LIKE lower(v_query) || '%'))))
  ), page AS (
    SELECT * FROM base
    WHERE p_status IS NULL OR (CASE WHEN last_state = 'resolved' THEN 'resolved' ELSE 'open' END) = p_status
    ORDER BY id DESC
    LIMIT v_limit + 1
  )
  SELECT count(*), coalesce(jsonb_agg(item ORDER BY id DESC) FILTER (WHERE rn <= v_limit), '[]'::jsonb)
  INTO v_found, v_items
  FROM (
    SELECT p.id, row_number() OVER (ORDER BY p.id DESC) AS rn, jsonb_build_object(
      'id', p.id,
      'opened_at', p.opened_at,
      'severity', p.severity,
      'environment', p.environment,
      'title', p.title,
      'status', CASE WHEN p.last_state = 'resolved' THEN 'resolved' ELSE 'open' END,
      'has_cause', EXISTS (SELECT 1 FROM admin.incident_events e WHERE e.incident_id = p.id AND e.kind = 'cause'),
      'has_fix', EXISTS (SELECT 1 FROM admin.incident_events e WHERE e.incident_id = p.id AND e.kind = 'fix'),
      'has_impact', EXISTS (SELECT 1 FROM admin.incident_events e WHERE e.incident_id = p.id AND e.kind = 'impact'),
      'resolved_at', CASE WHEN p.last_state = 'resolved' THEN
        (SELECT max(e.created_at) FROM admin.incident_events e WHERE e.incident_id = p.id AND e.kind = 'resolved') END,
      'events', (
        SELECT jsonb_agg(jsonb_build_object(
          'id', e.id, 'created_at', e.created_at, 'kind', e.kind, 'body', e.body, 'actor_role', e.actor_role, 'commit_sha', e.commit_sha
        ) ORDER BY e.created_at, e.id)
        FROM admin.incident_events e WHERE e.incident_id = p.id
      )
    ) AS item
    FROM page p
  ) numbered;

  RETURN jsonb_build_object(
    'as_of', now(),
    'counts', admin.incident_counts(),
    'incidents', v_items,
    'has_more', v_found > v_limit,
    'next_before_id', CASE WHEN v_found > v_limit THEN (SELECT min((x->>'id')::bigint) FROM jsonb_array_elements(v_items) x) END
  );
END
$function$;

CREATE OR REPLACE FUNCTION admin.incident_list(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT admin.incident_search(p_limit, NULL, NULL, NULL, NULL, NULL);
$function$;

REVOKE ALL ON FUNCTION admin.incident_notify(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_open(uuid, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_search(integer, text, timestamptz, timestamptz, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.incident_list(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.incident_open(uuid, text, text, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.incident_search(integer, text, timestamptz, timestamptz, text, bigint) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.incident_list(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.incident_notify(bigint, text, text) IS
  'Records one alerts notification for a SEV1 or SEV2 incident; SEV3 stays in the panel. Called by incident_open and incident_record only.';
COMMENT ON FUNCTION admin.incident_record(uuid, bigint, text, text, uuid, text) IS
  'Founder only: appends one timeline row with an optional full commit SHA; resolving needs cause, fix and impact; idempotent by key.';
COMMENT ON FUNCTION admin.incident_search(integer, text, timestamptz, timestamptz, text, bigint) IS
  'Incident counts and one page of incidents filtered by text or #id, opening period and status, newest first; roles, never people.';
COMMENT ON FUNCTION admin.incident_list(integer) IS
  'The unfiltered first page of admin.incident_search.';
