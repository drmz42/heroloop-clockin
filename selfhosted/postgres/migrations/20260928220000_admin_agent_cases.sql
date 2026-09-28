\set ON_ERROR_STOP on
-- AI agent cases in Control Center "AI agents" (Founder request 2026-09-28).
-- The Founder writes a task about the admin panel and picks Claude (claude2)
-- or Codex and a mode:
--   * investigate — the agent only reads a clean copy of origin/main and
--     answers: find, explain, diagnose;
--   * propose — the agent may edit its own disposable copy; the answer comes
--     with the diff. Nothing is pushed, installed or deployed: applying a diff
--     stays a separate Founder decision outside this queue.
-- The panel can only queue, read and cancel. Claiming a case and storing its
-- answer belong to the host runner (ops/run-admin-agent-case.sh) and are not
-- granted to the panel, so a browser can never forge an agent's answer or diff.
-- At most two open cases and 30 per day keep a runaway loop from spending the
-- subscriptions.

CREATE TABLE IF NOT EXISTS admin.agent_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL REFERENCES admin.identities(id),
  agent text NOT NULL CONSTRAINT agent_cases_agent CHECK (agent IN ('claude', 'codex')),
  mode text NOT NULL CONSTRAINT agent_cases_mode CHECK (mode IN ('investigate', 'propose')),
  prompt text NOT NULL CONSTRAINT agent_cases_prompt CHECK (char_length(prompt) BETWEEN 10 AND 4000),
  state text NOT NULL DEFAULT 'queued' CONSTRAINT agent_cases_state CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  claimed_at timestamptz,
  finished_at timestamptz,
  source_sha text CHECK (source_sha IS NULL OR source_sha ~ '^[0-9a-f]{40}$'),
  model text CHECK (model IS NULL OR model ~ '^[A-Za-z0-9._-]{1,60}$'),
  answer text CHECK (answer IS NULL OR char_length(answer) <= 40000),
  diff text CHECK (diff IS NULL OR char_length(diff) <= 300000),
  diff_stat text CHECK (diff_stat IS NULL OR char_length(diff_stat) <= 4000),
  error text CHECK (error IS NULL OR error ~ '^[a-z0-9_]{1,60}$')
);
CREATE INDEX IF NOT EXISTS agent_cases_recent ON admin.agent_cases(requested_at DESC);
CREATE INDEX IF NOT EXISTS agent_cases_open ON admin.agent_cases(requested_at) WHERE state IN ('queued', 'running');
REVOKE ALL ON admin.agent_cases FROM PUBLIC;
COMMENT ON TABLE admin.agent_cases IS
  'Founder tasks for Claude/Codex about the admin panel: prompt, mode, state, answer and (propose mode) the diff of the agent''s disposable copy. Nothing here is applied automatically.';

CREATE OR REPLACE FUNCTION admin.agent_case_require_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND role = 'founder' AND status = 'active') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION admin.agent_case_request(p_actor uuid, p_agent text, p_mode text, p_prompt text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_prompt text := btrim(coalesce(p_prompt, ''));
  v_id bigint;
BEGIN
  PERFORM admin.agent_case_require_founder(p_actor);
  IF p_agent IS NULL OR p_agent NOT IN ('claude', 'codex') THEN RAISE EXCEPTION 'invalid_agent' USING ERRCODE = '22023'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('investigate', 'propose') THEN RAISE EXCEPTION 'invalid_agent_mode' USING ERRCODE = '22023'; END IF;
  IF char_length(v_prompt) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'agent_prompt_required' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_case_queue', 0));
  IF (SELECT count(*) FROM admin.agent_cases WHERE state IN ('queued', 'running')) >= 2 THEN
    RAISE EXCEPTION 'agent_queue_full' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM admin.agent_cases WHERE requested_at > now() - interval '1 day') >= 30 THEN
    RAISE EXCEPTION 'agent_daily_limit' USING ERRCODE = '22023';
  END IF;
  INSERT INTO admin.agent_cases(requested_by, agent, mode, prompt) VALUES (p_actor, p_agent, p_mode, v_prompt) RETURNING id INTO v_id;
  RETURN jsonb_build_object('case_id', v_id, 'state', 'queued');
END
$function$;

-- Newest first, without the diff body (it can be large); the screen opens one
-- case with admin.agent_case_get for the full diff.
CREATE OR REPLACE FUNCTION admin.agent_case_list(p_actor uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  PERFORM admin.agent_case_require_founder(p_actor);
  RETURN jsonb_build_object(
    'open', (SELECT count(*) FROM admin.agent_cases WHERE state IN ('queued', 'running')),
    'today', (SELECT count(*) FROM admin.agent_cases WHERE requested_at > now() - interval '1 day'),
    'cases', coalesce((SELECT jsonb_agg(item ORDER BY (item->>'id')::bigint DESC) FROM (
      SELECT jsonb_build_object(
        'id', c.id, 'requested_at', c.requested_at, 'requested_by', i.email, 'agent', c.agent, 'mode', c.mode,
        'prompt', c.prompt, 'state', c.state, 'cancel_requested', c.cancel_requested, 'claimed_at', c.claimed_at,
        'finished_at', c.finished_at, 'source_sha', c.source_sha, 'model', c.model, 'answer', c.answer,
        'diff_stat', c.diff_stat, 'has_diff', c.diff IS NOT NULL AND c.diff <> '', 'error', c.error) AS item
      FROM admin.agent_cases c JOIN admin.identities i ON i.id = c.requested_by
      ORDER BY c.id DESC LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) recent), '[]'::jsonb)
  );
END
$function$;

CREATE OR REPLACE FUNCTION admin.agent_case_diff(p_actor uuid, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_case admin.agent_cases%ROWTYPE;
BEGIN
  PERFORM admin.agent_case_require_founder(p_actor);
  SELECT * INTO v_case FROM admin.agent_cases WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_case_not_found' USING ERRCODE = '22023'; END IF;
  RETURN jsonb_build_object('id', v_case.id, 'source_sha', v_case.source_sha, 'diff_stat', v_case.diff_stat, 'diff', coalesce(v_case.diff, ''));
END
$function$;

-- Cancel one case, or every open case at once (the kill switch). A queued case
-- is closed here; a running one is flagged and the runner stops its unit.
CREATE OR REPLACE FUNCTION admin.agent_case_cancel(p_actor uuid, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_queued integer;
  v_running integer;
BEGIN
  PERFORM admin.agent_case_require_founder(p_actor);
  IF p_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM admin.agent_cases WHERE id = p_id) THEN
    RAISE EXCEPTION 'agent_case_not_found' USING ERRCODE = '22023';
  END IF;
  UPDATE admin.agent_cases SET state = 'cancelled', cancel_requested = true, finished_at = now()
  WHERE state = 'queued' AND (p_id IS NULL OR id = p_id);
  GET DIAGNOSTICS v_queued = ROW_COUNT;
  UPDATE admin.agent_cases SET cancel_requested = true
  WHERE state = 'running' AND NOT cancel_requested AND (p_id IS NULL OR id = p_id);
  GET DIAGNOSTICS v_running = ROW_COUNT;
  RETURN jsonb_build_object('cancelled_queued', v_queued, 'stopping_running', v_running);
END
$function$;

-- Runner only. Closes a case stuck over 25 minutes, then takes the oldest
-- queued one.
CREATE OR REPLACE FUNCTION admin.agent_case_claim()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_case admin.agent_cases%ROWTYPE;
BEGIN
  UPDATE admin.agent_cases SET state = 'failed', finished_at = now(), error = 'runner_timeout'
  WHERE state = 'running' AND claimed_at < now() - interval '25 minutes';
  SELECT * INTO v_case FROM admin.agent_cases WHERE state = 'queued' ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE admin.agent_cases SET state = 'running', claimed_at = now() WHERE id = v_case.id;
  RETURN jsonb_build_object('case_id', v_case.id, 'agent', v_case.agent, 'mode', v_case.mode, 'prompt', v_case.prompt);
END
$function$;

CREATE OR REPLACE FUNCTION admin.agent_case_cancel_requested(p_id bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT coalesce((SELECT cancel_requested FROM admin.agent_cases WHERE id = p_id), true)
$function$;

-- Runner only. A case cancelled while running ends as cancelled whatever the
-- agent returned.
CREATE OR REPLACE FUNCTION admin.agent_case_finish(
  p_id bigint, p_ok boolean, p_source_sha text, p_model text, p_answer text, p_diff text, p_diff_stat text, p_error text
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  UPDATE admin.agent_cases SET
    state = CASE WHEN cancel_requested THEN 'cancelled' WHEN p_ok THEN 'done' ELSE 'failed' END,
    finished_at = now(),
    source_sha = p_source_sha,
    model = NULLIF(p_model, ''),
    answer = left(NULLIF(p_answer, ''), 40000),
    diff = CASE WHEN char_length(coalesce(p_diff, '')) <= 300000 THEN NULLIF(p_diff, '') END,
    diff_stat = left(NULLIF(p_diff_stat, ''), 4000),
    error = CASE WHEN cancel_requested THEN 'cancelled_by_founder'
                 WHEN char_length(coalesce(p_diff, '')) > 300000 THEN 'diff_too_large'
                 ELSE NULLIF(p_error, '') END
  WHERE id = p_id AND state = 'running';
END
$function$;

DO $audit_kinds$
DECLARE
  v_constraint text;
  v_kinds text[];
BEGIN
  -- The constraint prints either as ARRAY['a'::text, ...] or, once rewritten
  -- by an earlier migration, as '{a,b,...}'::text[]; this reads both.
  SELECT conname, ARRAY(SELECT m[1] FROM regexp_matches(pg_get_constraintdef(oid), '[''{,]\s*"?([a-z_]+)"?\s*(?=[''},])', 'g') m)
  INTO v_constraint, v_kinds
  FROM pg_constraint
  WHERE conrelid = 'admin.audit_log'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%event_kind%';
  IF v_constraint IS NULL OR cardinality(v_kinds) < 5 THEN RAISE EXCEPTION 'audit_kind_constraint_missing'; END IF;
  IF NOT 'agent_case' = ANY(v_kinds) THEN v_kinds := array_append(v_kinds, 'agent_case'); END IF;
  EXECUTE format('ALTER TABLE admin.audit_log DROP CONSTRAINT %I', v_constraint);
  EXECUTE format('ALTER TABLE admin.audit_log ADD CONSTRAINT audit_log_event_kind_check CHECK (event_kind = ANY (%L::text[]))', v_kinds);
END
$audit_kinds$;

REVOKE ALL ON FUNCTION admin.agent_case_require_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_request(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_list(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_diff(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_cancel(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_cancel_requested(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.agent_case_finish(bigint, boolean, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.agent_case_request(uuid, text, text, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.agent_case_list(uuid, integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.agent_case_diff(uuid, bigint) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.agent_case_cancel(uuid, bigint) TO heroloop_admin;

COMMENT ON FUNCTION admin.agent_case_request(uuid, text, text, text) IS
  'Founder queues one Claude/Codex case (investigate or propose) about the admin panel; two open, 30 per day.';
COMMENT ON FUNCTION admin.agent_case_list(uuid, integer) IS
  'Founder: recent agent cases with prompt, state, answer and diff summary (no diff body).';
COMMENT ON FUNCTION admin.agent_case_diff(uuid, bigint) IS
  'Founder: the full diff a propose-mode case left in its disposable copy.';
COMMENT ON FUNCTION admin.agent_case_cancel(uuid, bigint) IS
  'Founder: cancels one case, or every open case when the id is null (kill switch).';
COMMENT ON FUNCTION admin.agent_case_claim() IS
  'Runner only: claims the oldest queued agent case; not granted to the panel.';
COMMENT ON FUNCTION admin.agent_case_cancel_requested(bigint) IS
  'Runner only: whether the Founder asked to stop a running case.';
COMMENT ON FUNCTION admin.agent_case_finish(bigint, boolean, text, text, text, text, text, text) IS
  'Runner only: stores the agent answer, diff and failure code; not granted to the panel.';
