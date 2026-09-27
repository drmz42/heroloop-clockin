\set ON_ERROR_STOP on

-- Moderation of player reports in Control Center Community (Founder request
-- 2026-09-27, HL-TASK-20260924115307-992EE3). The Founder can:
--   * dismiss the open reports on an account (unfounded) or mark them resolved
--     (acted on, for example through the Player Support risk flow);
--   * reopen closed reports;
--   * delete all reports on an account, or one report;
--   * ask an AI agent (claude2, see ops/run-admin-report-agent.sh) for a
--     recommendation. The agent only reads a pseudonymous evidence packet and
--     answers with a verdict; it never acts, and the panel cannot forge its
--     answer because the claim and finish functions are not granted to it.
-- Every decision needs a founder, a written reason and an idempotency key, and
-- is kept in the append-only admin.player_report_actions (reference only, never
-- an account id). A report still changes nothing in the game by itself.

-- Status on the report itself: open until the Founder decides.
ALTER TABLE public.player_reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE public.player_reports ADD COLUMN IF NOT EXISTS decided_at timestamptz;
DO $status$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_reports_status' AND conrelid = 'public.player_reports'::regclass) THEN
    ALTER TABLE public.player_reports ADD CONSTRAINT player_reports_status CHECK (status IN ('open', 'dismissed', 'resolved'));
  END IF;
END
$status$;
CREATE INDEX IF NOT EXISTS player_reports_open_target ON public.player_reports(target_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS admin.player_report_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acted_at timestamptz NOT NULL DEFAULT now(),
  actor uuid NOT NULL REFERENCES admin.identities(id),
  target_ref text NOT NULL CONSTRAINT player_report_actions_ref CHECK (target_ref ~ '^[0-9a-f]{20}$'),
  action text NOT NULL CONSTRAINT player_report_actions_action CHECK (action IN ('dismiss', 'resolve', 'reopen', 'delete', 'delete_one')),
  report_id bigint,
  reports_affected integer NOT NULL CHECK (reports_affected >= 0),
  reason text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  result jsonb NOT NULL,
  CONSTRAINT player_report_actions_reason CHECK (char_length(reason) BETWEEN 5 AND 500),
  CONSTRAINT player_report_actions_reason_no_contact CHECK (position('@' IN reason) = 0)
);
CREATE INDEX IF NOT EXISTS player_report_actions_ref ON admin.player_report_actions(target_ref, acted_at DESC);
REVOKE ALL ON admin.player_report_actions FROM PUBLIC;
COMMENT ON TABLE admin.player_report_actions IS
  'Append-only Founder decisions on player reports: action, reference, how many reports it touched, reason; never an account id.';

-- Agent review queue. The target id stays inside the database: the panel reads
-- rows only through admin.player_report_list, which shows the reference.
CREATE TABLE IF NOT EXISTS admin.player_report_agent_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by uuid NOT NULL REFERENCES admin.identities(id),
  target_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CONSTRAINT player_report_agent_state CHECK (state IN ('queued', 'running', 'done', 'failed')),
  claimed_at timestamptz,
  finished_at timestamptz,
  model text CHECK (model IS NULL OR model ~ '^[a-z0-9.-]{1,60}$'),
  result jsonb,
  error text CHECK (error IS NULL OR error ~ '^[a-z0-9_]{1,60}$')
);
CREATE INDEX IF NOT EXISTS player_report_agent_reviews_target ON admin.player_report_agent_reviews(target_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS player_report_agent_reviews_queue ON admin.player_report_agent_reviews(requested_at) WHERE state IN ('queued', 'running');
REVOKE ALL ON admin.player_report_agent_reviews FROM PUBLIC;
COMMENT ON TABLE admin.player_report_agent_reviews IS
  'AI agent recommendations on reported accounts: who asked, state, validated verdict/recommendation/summary; readable only through admin.player_report_list.';

CREATE OR REPLACE FUNCTION admin.player_report_require_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND role = 'founder' AND status = 'active') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

-- The account behind a reference, over every report ever kept (not only the
-- list window), so an old report can still be closed or deleted.
CREATE OR REPLACE FUNCTION admin.player_report_target(p_ref text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT t.target_id FROM (SELECT DISTINCT target_id FROM public.player_reports) t
  WHERE p_ref ~ '^[0-9a-f]{20}$' AND admin.player_report_ref(t.target_id) = p_ref
  LIMIT 1
$function$;

-- One decision. dismiss/resolve close the open reports on the account, reopen
-- opens its closed ones, delete removes all of its reports, delete_one removes
-- one report of that account. A retry with the same key returns the first
-- result; the same key for another decision is refused.
CREATE OR REPLACE FUNCTION admin.player_report_decide(
  p_actor uuid, p_ref text, p_action text, p_reason text, p_idempotency_key uuid, p_report_id bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  v_prior admin.player_report_actions%ROWTYPE;
  v_target uuid;
  v_count integer := 0;
  v_result jsonb;
BEGIN
  PERFORM admin.player_report_require_founder(p_actor);
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('dismiss', 'resolve', 'reopen', 'delete', 'delete_one') THEN
    RAISE EXCEPTION 'invalid_report_action' USING ERRCODE = '22023';
  END IF;
  IF (p_action = 'delete_one') <> (p_report_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid_report_action' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  IF position('@' IN v_reason) > 0 OR v_reason ~ '[A-Za-z0-9]{26}' THEN
    RAISE EXCEPTION 'reason_carries_identifier' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_prior FROM admin.player_report_actions WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior.target_ref <> p_ref OR v_prior.action <> p_action OR v_prior.report_id IS DISTINCT FROM p_report_id THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  v_target := admin.player_report_target(p_ref);
  IF v_target IS NULL THEN RAISE EXCEPTION 'report_not_found' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('player_report_target:' || v_target::text, 0));

  IF p_action IN ('dismiss', 'resolve') THEN
    UPDATE public.player_reports SET status = CASE p_action WHEN 'dismiss' THEN 'dismissed' ELSE 'resolved' END, decided_at = now()
    WHERE target_id = v_target AND status = 'open';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN RAISE EXCEPTION 'nothing_open' USING ERRCODE = '22023'; END IF;
  ELSIF p_action = 'reopen' THEN
    UPDATE public.player_reports SET status = 'open', decided_at = NULL
    WHERE target_id = v_target AND status <> 'open';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN RAISE EXCEPTION 'nothing_closed' USING ERRCODE = '22023'; END IF;
  ELSIF p_action = 'delete' THEN
    DELETE FROM public.player_reports WHERE target_id = v_target;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    DELETE FROM public.player_reports WHERE target_id = v_target AND report_id = p_report_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count = 0 THEN RAISE EXCEPTION 'report_not_found' USING ERRCODE = '22023'; END IF;
  END IF;

  v_result := jsonb_build_object('action', p_action, 'reports_affected', v_count, 'replayed', false);
  INSERT INTO admin.player_report_actions(actor, target_ref, action, report_id, reports_affected, reason, idempotency_key, result)
  VALUES (p_actor, p_ref, p_action, p_report_id, v_count, v_reason, p_idempotency_key, v_result);
  RETURN v_result;
END
$function$;

-- Queue one agent review. One pending review per account and at most five in
-- the queue, so a double click or a runaway loop cannot spend the subscription.
CREATE OR REPLACE FUNCTION admin.player_report_agent_request(p_actor uuid, p_ref text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_target uuid;
  v_id bigint;
BEGIN
  PERFORM admin.player_report_require_founder(p_actor);
  v_target := admin.player_report_target(p_ref);
  IF v_target IS NULL THEN RAISE EXCEPTION 'report_not_found' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('player_report_agent_queue', 0));
  IF EXISTS (SELECT 1 FROM admin.player_report_agent_reviews WHERE target_id = v_target AND state IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'agent_review_pending' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM admin.player_report_agent_reviews WHERE state IN ('queued', 'running')) >= 5 THEN
    RAISE EXCEPTION 'agent_queue_full' USING ERRCODE = '22023';
  END IF;
  INSERT INTO admin.player_report_agent_reviews(requested_by, target_id) VALUES (p_actor, v_target) RETURNING id INTO v_id;
  RETURN jsonb_build_object('review_id', v_id, 'state', 'queued');
END
$function$;

-- The runner's claim: closes a review stuck over ten minutes, takes the oldest
-- queued one and hands over its evidence packet. The packet carries no account
-- id, mail or wallet; the name only when someone reported it as offensive.
-- Comments are players' free text and are marked as untrusted for the agent.
CREATE OR REPLACE FUNCTION admin.player_report_agent_claim()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_review admin.player_report_agent_reviews%ROWTYPE;
  v_player jsonb;
  v_age_days numeric;
  v_kills_per_day numeric;
  v_name_reported boolean;
  v_risk jsonb := NULL;
BEGIN
  UPDATE admin.player_report_agent_reviews SET state = 'failed', finished_at = now(), error = 'runner_timeout'
  WHERE state = 'running' AND claimed_at < now() - interval '10 minutes';

  SELECT * INTO v_review FROM admin.player_report_agent_reviews
  WHERE state = 'queued' ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE admin.player_report_agent_reviews SET state = 'running', claimed_at = now() WHERE id = v_review.id;

  SELECT to_jsonb(p) INTO v_player FROM public.players p WHERE p.player_id = v_review.target_id;
  SELECT greatest(extract(epoch FROM now() - u.created_at) / 86400, 0.04) INTO v_age_days FROM auth.users u WHERE u.id = v_review.target_id;
  v_age_days := coalesce(v_age_days, 1);
  v_kills_per_day := coalesce((v_player->>'total_kills')::numeric, 0) / v_age_days;
  SELECT bool_or(reason = 'offensive_name') INTO v_name_reported FROM public.player_reports WHERE target_id = v_review.target_id;
  IF to_regclass('public.account_risk_levels') IS NOT NULL THEN
    EXECUTE 'SELECT jsonb_build_object(''level'', level, ''reason_codes'', to_jsonb(reason_codes)) FROM public.account_risk_levels WHERE player_id = $1'
      INTO v_risk USING v_review.target_id;
  END IF;

  RETURN jsonb_build_object(
    'review_id', v_review.id,
    'packet', jsonb_build_object(
      'version', 'player-report-evidence.v1',
      'as_of', now(),
      'reports', (SELECT jsonb_build_object(
          'total', count(*), 'open', count(*) FILTER (WHERE status = 'open'),
          'distinct_reporters', count(DISTINCT reporter_id),
          'reasons', (SELECT jsonb_object_agg(reason, n) FROM (SELECT reason, count(*) n FROM public.player_reports WHERE target_id = v_review.target_id GROUP BY reason) r),
          'first_at', min(created_at), 'last_at', max(created_at),
          'untrusted_player_comments', coalesce((SELECT jsonb_agg(c.comment ORDER BY c.created_at DESC) FROM (
            SELECT comment, created_at FROM public.player_reports WHERE target_id = v_review.target_id AND comment IS NOT NULL
            ORDER BY created_at DESC LIMIT 10) c), '[]'::jsonb))
        FROM public.player_reports WHERE target_id = v_review.target_id),
      'player', jsonb_build_object(
        'account_age_days', round(v_age_days, 1),
        'account_level', (v_player->>'account_level')::numeric,
        'power', (v_player->>'power')::numeric,
        'collection_power', (v_player->>'collection_power')::numeric,
        'total_kills', (v_player->>'total_kills')::numeric,
        'kills_per_day', round(v_kills_per_day, 1),
        'boss_kills', (v_player->>'boss_kills')::numeric,
        'summons', (v_player->>'summons')::numeric,
        'heroes_owned', (v_player->>'heroes_owned')::numeric,
        'highest_location', (v_player->>'highest_location')::numeric,
        'total_tokens_earned', (v_player->>'total_tokens_earned')::numeric,
        'online_now', (v_player->>'online')::boolean,
        'hours_since_last_seen', round(extract(epoch FROM now() - (v_player->>'last_heartbeat')::timestamptz) / 3600, 1),
        'username_for_offensive_name_check', CASE WHEN v_name_reported THEN v_player->>'username' END
      ),
      'risk', coalesce(v_risk, jsonb_build_object('level', 'normal', 'reason_codes', '[]'::jsonb)),
      'population', (SELECT jsonb_build_object(
          'players', count(*),
          'account_level_p50_p90_p99', jsonb_build_array(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.account_level), percentile_cont(0.9) WITHIN GROUP (ORDER BY p.account_level), percentile_cont(0.99) WITHIN GROUP (ORDER BY p.account_level)),
          'power_p50_p90_p99', jsonb_build_array(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.power), percentile_cont(0.9) WITHIN GROUP (ORDER BY p.power), percentile_cont(0.99) WITHIN GROUP (ORDER BY p.power)),
          'total_kills_p50_p90_p99', jsonb_build_array(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.total_kills), percentile_cont(0.9) WITHIN GROUP (ORDER BY p.total_kills), percentile_cont(0.99) WITHIN GROUP (ORDER BY p.total_kills)),
          'boss_kills_p50_p90_p99', jsonb_build_array(percentile_cont(0.5) WITHIN GROUP (ORDER BY p.boss_kills), percentile_cont(0.9) WITHIN GROUP (ORDER BY p.boss_kills), percentile_cont(0.99) WITHIN GROUP (ORDER BY p.boss_kills)),
          'kills_per_day_p50_p90_p99', jsonb_build_array(
            percentile_cont(0.5) WITHIN GROUP (ORDER BY p.total_kills / greatest(extract(epoch FROM now() - u.created_at) / 86400, 0.04)),
            percentile_cont(0.9) WITHIN GROUP (ORDER BY p.total_kills / greatest(extract(epoch FROM now() - u.created_at) / 86400, 0.04)),
            percentile_cont(0.99) WITHIN GROUP (ORDER BY p.total_kills / greatest(extract(epoch FROM now() - u.created_at) / 86400, 0.04))))
        FROM public.players p JOIN auth.users u ON u.id = p.player_id)
    )
  );
END
$function$;

-- The runner's answer. Only a validated shape is stored: fixed verdict,
-- recommendation and confidence values and a summary without an address.
CREATE OR REPLACE FUNCTION admin.player_report_agent_finish(p_id bigint, p_ok boolean, p_result jsonb, p_error text, p_model text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_summary text := btrim(coalesce(p_result->>'summary', ''));
BEGIN
  IF p_ok AND (
      jsonb_typeof(p_result) IS DISTINCT FROM 'object'
      OR coalesce(p_result->>'verdict', '') NOT IN ('likely_valid', 'unclear', 'likely_unfounded')
      OR coalesce(p_result->>'recommendation', '') NOT IN ('dismiss', 'resolve', 'watch', 'review')
      OR coalesce(p_result->>'confidence', '') NOT IN ('low', 'medium', 'high')
      OR char_length(v_summary) NOT BETWEEN 10 AND 1200
      OR position('@' IN v_summary) > 0) THEN
    p_ok := false;
    p_error := 'agent_answer_invalid';
  END IF;
  UPDATE admin.player_report_agent_reviews SET
    state = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
    finished_at = now(),
    model = CASE WHEN p_model ~ '^[a-z0-9.-]{1,60}$' THEN p_model END,
    result = CASE WHEN p_ok THEN jsonb_build_object('verdict', p_result->>'verdict', 'recommendation', p_result->>'recommendation',
      'confidence', p_result->>'confidence', 'summary', v_summary) END,
    error = CASE WHEN p_ok THEN NULL WHEN p_error ~ '^[a-z0-9_]{1,60}$' THEN p_error ELSE 'agent_failed' END
  WHERE id = p_id AND state = 'running';
END
$function$;

-- The report queue, now with status: open accounts first (or closed, or all),
-- the twenty newest reports of each account with their own id, status counts,
-- and the newest agent review. Still never an account id, name, mail, wallet
-- or reporter.
DROP FUNCTION IF EXISTS admin.player_report_list(integer, integer);
-- No defaults: a two-argument call must resolve to the compatibility form below.
CREATE OR REPLACE FUNCTION admin.player_report_list(p_days integer, p_limit integer, p_status text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_status text := CASE WHEN p_status IN ('open', 'closed', 'all') THEN p_status ELSE 'open' END;
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90));
  v_reports bigint;
  v_open bigint;
  v_targets bigint;
  v_reasons jsonb;
  v_rows jsonb;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'open') INTO v_reports, v_open
  FROM public.player_reports WHERE created_at >= v_since;
  SELECT coalesce(jsonb_object_agg(reason, reports), '{}'::jsonb) INTO v_reasons
  FROM (SELECT reason, count(*) AS reports FROM public.player_reports WHERE created_at >= v_since GROUP BY reason) r;

  WITH scoped AS (
    SELECT target_id FROM public.player_reports WHERE created_at >= v_since GROUP BY target_id
    HAVING v_status = 'all'
        OR (v_status = 'open' AND bool_or(status = 'open'))
        OR (v_status = 'closed' AND NOT bool_or(status = 'open'))
  )
  SELECT count(*) INTO v_targets FROM scoped;

  SELECT coalesce(jsonb_agg(row_data ORDER BY open_reports DESC, reports DESC, last_at DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT
      count(*) FILTER (WHERE p.status = 'open') AS open_reports,
      count(*) AS reports,
      max(p.created_at) AS last_at,
      jsonb_build_object(
        'ref', admin.player_report_ref(p.target_id),
        'reports', count(*),
        'open', count(*) FILTER (WHERE p.status = 'open'),
        'dismissed', count(*) FILTER (WHERE p.status = 'dismissed'),
        'resolved', count(*) FILTER (WHERE p.status = 'resolved'),
        'reporters', count(DISTINCT p.reporter_id),
        'reasons', (SELECT jsonb_object_agg(x.reason, x.n) FROM (
          SELECT reason, count(*) AS n FROM public.player_reports
          WHERE target_id = p.target_id AND created_at >= v_since GROUP BY reason) x),
        'first_at', min(p.created_at),
        'last_at', max(p.created_at),
        'items', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.report_id, 'reason', i.reason, 'comment', i.comment, 'status', i.status, 'at', i.created_at) ORDER BY i.created_at DESC)
          FROM (SELECT report_id, reason, comment, status, created_at FROM public.player_reports
                WHERE target_id = p.target_id AND created_at >= v_since
                ORDER BY created_at DESC LIMIT 20) i), '[]'::jsonb),
        'agent', (SELECT jsonb_build_object('state', a.state, 'requested_at', a.requested_at, 'finished_at', a.finished_at,
            'model', a.model, 'result', a.result, 'error', a.error)
          FROM admin.player_report_agent_reviews a WHERE a.target_id = p.target_id ORDER BY a.requested_at DESC, a.id DESC LIMIT 1)
      ) AS row_data
    FROM public.player_reports p
    WHERE p.created_at >= v_since
    GROUP BY p.target_id
    HAVING v_status = 'all'
        OR (v_status = 'open' AND bool_or(p.status = 'open'))
        OR (v_status = 'closed' AND NOT bool_or(p.status = 'open'))
    ORDER BY count(*) FILTER (WHERE p.status = 'open') DESC, count(*) DESC, max(p.created_at) DESC
    LIMIT v_limit
  ) q;

  RETURN jsonb_build_object(
    'version', 'player-reports.v2',
    'as_of', now(),
    'timezone', 'UTC',
    'window_days', v_days,
    'status', v_status,
    'reports', v_reports,
    'open_reports', v_open,
    'reported_players', v_targets,
    'reasons', v_reasons,
    'agent_queue', (SELECT count(*) FROM admin.player_report_agent_reviews WHERE state IN ('queued', 'running')),
    'limit', v_limit,
    'truncated', v_targets > v_limit,
    'rows', v_rows
  );
END
$function$;

-- Kept for a panel still running the previous build until it is reinstalled.
CREATE OR REPLACE FUNCTION admin.player_report_list(p_days integer, p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$ SELECT admin.player_report_list(p_days, p_limit, 'all') $function$;

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
    'simulation_run', 'incident_record', 'support_ticket', 'finance_record', 'privacy_request', 'ledger_baseline',
    'player_report_action'
  ));
END
$audit_kinds$;

REVOKE ALL ON FUNCTION admin.player_report_require_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_target(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_decide(uuid, text, text, text, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_agent_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_agent_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_agent_finish(bigint, boolean, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_list(integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_list(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.player_report_decide(uuid, text, text, text, uuid, bigint) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.player_report_agent_request(uuid, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.player_report_list(integer, integer, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.player_report_list(integer, integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.player_report_decide(uuid, text, text, text, uuid, bigint) IS
  'Founder decision on the reports of one account: dismiss, resolve, reopen, delete all or delete one; reason and idempotency key; recorded in admin.player_report_actions.';
COMMENT ON FUNCTION admin.player_report_agent_request(uuid, text) IS
  'Queues one AI agent review of a reported account; one pending per account, five in the queue; founder only.';
COMMENT ON FUNCTION admin.player_report_agent_claim() IS
  'Runner only: claims the oldest queued agent review and returns its pseudonymous evidence packet; not granted to the panel.';
COMMENT ON FUNCTION admin.player_report_agent_finish(bigint, boolean, jsonb, text, text) IS
  'Runner only: stores a validated agent answer (verdict, recommendation, confidence, summary) or the failure code; not granted to the panel.';
