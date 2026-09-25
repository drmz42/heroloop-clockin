-- Simulation runs from the Config screen. A founder asks for one of the
-- repository's simulate-*.mjs scripts to be run; the request waits here until
-- the host runner (ops/run-admin-simulations.sh) claims it, runs the script in
-- a sandbox against the commit Staging is running, and writes the outcome back.
-- The panel can only ask and read: claiming and finishing are not granted to
-- its role, so a browser can never forge a result. A script already waiting or
-- running is not queued twice, and the queue holds at most five requests.

CREATE TABLE IF NOT EXISTS admin.simulation_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL REFERENCES admin.identities(id),
  script text NOT NULL CHECK (script ~ '^simulate-[a-z0-9-]{2,60}\.mjs$'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
  exit_code integer,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  output_path text CHECK (output_path IS NULL OR output_path ~ '^docs/game/data/[a-z0-9-]+-summary\.json$'),
  matches_committed boolean,
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096)),
  error text CHECK (error IS NULL OR error ~ '^[a-z_]{3,60}$')
);
CREATE INDEX IF NOT EXISTS simulation_runs_status_idx ON admin.simulation_runs(status, requested_at);
CREATE INDEX IF NOT EXISTS simulation_runs_script_idx ON admin.simulation_runs(script, requested_at DESC);
ALTER TABLE admin.simulation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE admin.simulation_runs FROM PUBLIC;

CREATE OR REPLACE FUNCTION admin.simulation_request(p_actor uuid, p_script text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_actor admin.identities%ROWTYPE;
  v_existing admin.simulation_runs%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id bigint;
BEGIN
  SELECT * INTO v_actor FROM admin.identities WHERE id = p_actor;
  IF NOT FOUND OR v_actor.role <> 'founder' OR v_actor.status <> 'active' THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  IF p_script IS NULL OR p_script !~ '^simulate-[a-z0-9-]{2,60}\.mjs$' THEN
    RAISE EXCEPTION 'unknown_simulation' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('heroloop.simulation_queue'));
  SELECT * INTO v_existing FROM admin.simulation_runs
  WHERE script = p_script AND status IN ('queued', 'running') ORDER BY requested_at LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'already_queued', true);
  END IF;
  IF (SELECT count(*) FROM admin.simulation_runs WHERE status IN ('queued', 'running')) >= 5 THEN
    RAISE EXCEPTION 'simulation_queue_full' USING ERRCODE = '22023';
  END IF;
  INSERT INTO admin.simulation_runs (requested_by, script, reason) VALUES (p_actor, p_script, v_reason) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'status', 'queued', 'already_queued', false);
END;
$$;

-- The last 50 runs, newest first, with who asked. No output beyond the
-- headline scalars the runner kept.
CREATE OR REPLACE FUNCTION admin.simulation_runs_list()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'script', r.script, 'status', r.status, 'requested_at', r.requested_at, 'requested_by', i.email,
    'reason', r.reason, 'started_at', r.started_at, 'finished_at', r.finished_at, 'commit', r.commit_sha,
    'exit_code', r.exit_code, 'duration_ms', r.duration_ms, 'output_path', r.output_path,
    'matches_committed', r.matches_committed, 'result', r.result, 'error', r.error) ORDER BY r.requested_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM admin.simulation_runs ORDER BY requested_at DESC LIMIT 50) r
  JOIN admin.identities i ON i.id = r.requested_by;
$$;

-- Runner only. Takes the oldest waiting request; a run left "running" for
-- more than fifteen minutes (the runner died) is closed as failed first.
CREATE OR REPLACE FUNCTION admin.simulation_claim()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
DECLARE
  v_run admin.simulation_runs%ROWTYPE;
BEGIN
  UPDATE admin.simulation_runs SET status = 'failed', finished_at = now(), error = 'runner_timeout'
  WHERE status = 'running' AND started_at < now() - interval '15 minutes';
  SELECT * INTO v_run FROM admin.simulation_runs WHERE status = 'queued'
  ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE admin.simulation_runs SET status = 'running', started_at = now() WHERE id = v_run.id;
  RETURN jsonb_build_object('id', v_run.id, 'script', v_run.script);
END;
$$;

CREATE OR REPLACE FUNCTION admin.simulation_finish(
  p_id bigint, p_passed boolean, p_commit text, p_exit_code integer, p_duration_ms integer,
  p_output_path text, p_matches_committed boolean, p_result jsonb, p_error text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, admin AS $$
BEGIN
  UPDATE admin.simulation_runs SET
    status = CASE WHEN p_passed THEN 'passed' ELSE 'failed' END,
    finished_at = now(), commit_sha = p_commit, exit_code = p_exit_code, duration_ms = p_duration_ms,
    output_path = p_output_path, matches_committed = p_matches_committed, result = p_result, error = p_error
  WHERE id = p_id AND status = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'simulation_not_running' USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION admin.simulation_request(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.simulation_runs_list() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.simulation_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.simulation_finish(bigint, boolean, text, integer, integer, text, boolean, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.simulation_request(uuid, text, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.simulation_runs_list() TO heroloop_admin;
-- simulation_claim and simulation_finish are deliberately not granted to the
-- panel: only the host runner, as the database owner, may call them.

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
    'simulation_run'
  ));
END
$audit_kinds$;
