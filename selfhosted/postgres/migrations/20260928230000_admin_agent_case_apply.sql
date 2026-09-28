\set ON_ERROR_STOP on
-- Applying an agent's proposed diff from Control Center "AI agents" (Founder
-- request and approval 2026-09-28). The Founder presses "Apply" on a
-- finished propose-mode case; the host runner (ops/run-admin-agent-case.sh),
-- not the agent, applies the stored diff to current origin/main, refuses any
-- path outside the admin panel, runs the panel checks in a sandbox without
-- network or sudo, commits, pushes the exact SHA and installs the panel with
-- its own verification and rollback. The panel can only request an apply;
-- claiming and finishing one are not granted to it. One apply at a time.

ALTER TABLE admin.agent_cases
  ADD COLUMN IF NOT EXISTS apply_state text CONSTRAINT agent_cases_apply_state CHECK (apply_state IS NULL OR apply_state IN ('queued', 'running', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS apply_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS apply_requested_by uuid REFERENCES admin.identities(id),
  ADD COLUMN IF NOT EXISTS apply_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS apply_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS apply_sha text CONSTRAINT agent_cases_apply_sha CHECK (apply_sha IS NULL OR apply_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN IF NOT EXISTS apply_error text CONSTRAINT agent_cases_apply_error CHECK (apply_error IS NULL OR apply_error ~ '^[a-z0-9_]{1,60}$'),
  ADD COLUMN IF NOT EXISTS apply_log text CONSTRAINT agent_cases_apply_log CHECK (apply_log IS NULL OR char_length(apply_log) <= 6000);
CREATE INDEX IF NOT EXISTS agent_cases_apply_open ON admin.agent_cases(apply_requested_at) WHERE apply_state IN ('queued', 'running');

CREATE OR REPLACE FUNCTION admin.agent_case_apply_request(p_actor uuid, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_case admin.agent_cases%ROWTYPE;
BEGIN
  PERFORM admin.agent_case_require_founder(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_case_apply', 0));
  SELECT * INTO v_case FROM admin.agent_cases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_case_not_found' USING ERRCODE = '22023'; END IF;
  IF v_case.mode <> 'propose' OR v_case.state <> 'done' OR coalesce(v_case.diff, '') = '' THEN
    RAISE EXCEPTION 'agent_apply_not_ready' USING ERRCODE = '22023';
  END IF;
  IF v_case.apply_state IN ('queued', 'running', 'done') THEN
    RAISE EXCEPTION 'agent_apply_already_requested' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM admin.agent_cases WHERE apply_state IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'agent_apply_busy' USING ERRCODE = '22023';
  END IF;
  UPDATE admin.agent_cases SET apply_state = 'queued', apply_requested_at = now(), apply_requested_by = p_actor,
    apply_claimed_at = NULL, apply_finished_at = NULL, apply_sha = NULL, apply_error = NULL, apply_log = NULL
  WHERE id = p_id;
  RETURN jsonb_build_object('case_id', p_id, 'apply_state', 'queued');
END
$function$;

-- Runner only. Fails an apply stuck over 40 minutes, then takes the oldest
-- queued one with its diff and the commit the diff was made against.
CREATE OR REPLACE FUNCTION admin.agent_case_apply_claim()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_case admin.agent_cases%ROWTYPE;
BEGIN
  UPDATE admin.agent_cases SET apply_state = 'failed', apply_finished_at = now(), apply_error = 'runner_timeout'
  WHERE apply_state = 'running' AND apply_claimed_at < now() - interval '40 minutes';
  SELECT * INTO v_case FROM admin.agent_cases WHERE apply_state = 'queued' ORDER BY apply_requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE admin.agent_cases SET apply_state = 'running', apply_claimed_at = now() WHERE id = v_case.id;
  RETURN jsonb_build_object('case_id', v_case.id, 'agent', v_case.agent, 'source_sha', v_case.source_sha, 'diff', v_case.diff);
END
$function$;

CREATE OR REPLACE FUNCTION admin.agent_case_apply_finish(p_id bigint, p_ok boolean, p_sha text, p_error text, p_log text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  UPDATE admin.agent_cases SET
    apply_state = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
    apply_finished_at = now(),
    apply_sha = NULLIF(p_sha, ''),
    apply_error = NULLIF(p_error, ''),
    apply_log = right(NULLIF(p_log, ''), 6000)
  WHERE id = p_id AND apply_state = 'running';
END
$function$;

-- The list now carries the apply state beside each case.
CREATE OR REPLACE FUNCTION admin.agent_case_list(p_actor uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  PERFORM admin.agent_case_require_founder(p_actor);
  RETURN jsonb_build_object(
    'open', (SELECT count(*) FROM admin.agent_cases WHERE state IN ('queued', 'running')),
    'applying', (SELECT count(*) FROM admin.agent_cases WHERE apply_state IN ('queued', 'running')),
    'today', (SELECT count(*) FROM admin.agent_cases WHERE requested_at > now() - interval '1 day'),
    'cases', coalesce((SELECT jsonb_agg(item ORDER BY (item->>'id')::bigint DESC) FROM (
      SELECT jsonb_build_object(
        'id', c.id, 'requested_at', c.requested_at, 'requested_by', i.email, 'agent', c.agent, 'mode', c.mode,
        'prompt', c.prompt, 'state', c.state, 'cancel_requested', c.cancel_requested, 'claimed_at', c.claimed_at,
        'finished_at', c.finished_at, 'source_sha', c.source_sha, 'model', c.model, 'answer', c.answer,
        'diff_stat', c.diff_stat, 'has_diff', c.diff IS NOT NULL AND c.diff <> '', 'error', c.error,
        'apply_state', c.apply_state, 'apply_requested_at', c.apply_requested_at, 'apply_finished_at', c.apply_finished_at,
        'apply_sha', c.apply_sha, 'apply_error', c.apply_error, 'apply_log', c.apply_log) AS item
      FROM admin.agent_cases c JOIN admin.identities i ON i.id = c.requested_by
      ORDER BY c.id DESC LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) recent), '[]'::jsonb)
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.agent_case_apply_request(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_apply_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_apply_finish(bigint, boolean, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.agent_case_apply_request(uuid, bigint) TO heroloop_admin;

COMMENT ON FUNCTION admin.agent_case_apply_request(uuid, bigint) IS
  'Founder asks the runner to apply a finished propose-mode diff (commit, push, panel install); one at a time.';
COMMENT ON FUNCTION admin.agent_case_apply_claim() IS
  'Runner only: claims the oldest queued apply with its diff; not granted to the panel.';
COMMENT ON FUNCTION admin.agent_case_apply_finish(bigint, boolean, text, text, text) IS
  'Runner only: records the pushed SHA or the failure code and log tail; not granted to the panel.';
