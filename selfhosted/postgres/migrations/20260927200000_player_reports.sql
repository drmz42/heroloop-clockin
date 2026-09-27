\set ON_ERROR_STOP on

-- Player reports (Founder decision 2026-09-27, HL-TASK-20260924115307-992EE3):
-- the first data source for the Control Center Community domain. A signed-in
-- player reports another player from the leaderboard with one fixed reason and
-- an optional short comment. A report changes nothing in the game by itself: no
-- restriction, no penalty and no reward follows from it automatically. The
-- reporter is never shown to anyone; the Founder sees reports grouped per
-- reported account behind an opaque reference and opens the account through
-- Player Support with its reason, masking and audit rules.
--
-- Limits: one report per reporter and reported player per UTC day, at most ten
-- reports per reporter per UTC day, plus the API rate limit below. Rows are
-- removed with either account.

CREATE TABLE IF NOT EXISTS public.player_reports (
  report_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key uuid NOT NULL UNIQUE,
  reporter_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  reason text NOT NULL CONSTRAINT player_reports_reason CHECK (reason IN ('cheating', 'bot', 'offensive_name', 'other')),
  comment text CONSTRAINT player_reports_comment CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 300),
  report_day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_reports_not_self CHECK (reporter_id <> target_id),
  CONSTRAINT player_reports_once_per_day UNIQUE (reporter_id, target_id, report_day)
);
CREATE INDEX IF NOT EXISTS player_reports_target_created ON public.player_reports(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS player_reports_created ON public.player_reports(created_at DESC);
REVOKE ALL ON public.player_reports FROM PUBLIC;

-- The only write. The target must be an existing account other than the caller.
-- A repeat of the same idempotency key returns the first result; the key reused
-- for another report is a conflict. A second report of the same player on the
-- same day is not an error: the player sees that it is already recorded.
CREATE OR REPLACE FUNCTION heroloop_api.player_report_submit(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_target_id uuid,
  p_reason text,
  p_comment text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_comment text := nullif(btrim(regexp_replace(coalesce(p_comment, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_existing public.player_reports%ROWTYPE;
  v_today integer;
  v_id bigint;
BEGIN
  IF p_player_id IS NULL OR p_idempotency_key IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'invalid_report';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('cheating', 'bot', 'offensive_name', 'other') THEN
    RAISE EXCEPTION 'invalid_report_reason';
  END IF;
  IF v_comment IS NOT NULL AND char_length(v_comment) > 300 THEN
    RAISE EXCEPTION 'invalid_report_comment';
  END IF;

  SELECT * INTO v_existing FROM public.player_reports WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.reporter_id <> p_player_id OR v_existing.target_id <> p_target_id
       OR v_existing.reason <> p_reason OR v_existing.comment IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('report_id', v_existing.report_id, 'status', 'recorded', 'replayed', true);
  END IF;

  IF p_target_id = p_player_id THEN RAISE EXCEPTION 'report_self'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id) THEN
    RAISE EXCEPTION 'player_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_target_id) THEN
    RAISE EXCEPTION 'report_target_not_found';
  END IF;

  -- One reporter at a time, so the daily cap cannot be raced past.
  PERFORM pg_advisory_xact_lock(hashtextextended('player_report:' || p_player_id::text, 0));

  SELECT report_id INTO v_id FROM public.player_reports
  WHERE reporter_id = p_player_id AND target_id = p_target_id AND report_day = v_day;
  IF FOUND THEN
    RETURN jsonb_build_object('report_id', v_id, 'status', 'already_reported', 'replayed', false);
  END IF;

  SELECT count(*) INTO v_today FROM public.player_reports
  WHERE reporter_id = p_player_id AND report_day = v_day;
  IF v_today >= 10 THEN RAISE EXCEPTION 'report_daily_limit'; END IF;

  INSERT INTO public.player_reports(idempotency_key, reporter_id, target_id, reason, comment, report_day)
  VALUES (p_idempotency_key, p_player_id, p_target_id, p_reason, v_comment, v_day)
  RETURNING report_id INTO v_id;
  RETURN jsonb_build_object('report_id', v_id, 'status', 'recorded', 'replayed', false);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.player_report_submit(uuid, uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.player_report_submit(uuid, uuid, uuid, text, text) TO heroloop_api;
COMMENT ON FUNCTION heroloop_api.player_report_submit(uuid, uuid, uuid, text, text) IS
  'Records one player report (fixed reason, optional 300-character comment); once per reporter and target per UTC day, ten per reporter per day; changes no game state.';

-- The rate-limit table gains player_report (five per five minutes). Patched in
-- place like 20260926160000_reward_boost_purchase.sql, so the entries later
-- migrations added stay; a re-run finds it present and changes nothing. The
-- admin foundation fixture carries no game API rate limiter, so a database
-- without the function is left alone (the command then fails closed with
-- api_unknown_rate_limit_action).
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  IF to_regprocedure('heroloop_api.consume_rate_limit(uuid,text)') IS NULL THEN RETURN; END IF;
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  IF position('(''player_report'',5,300)' IN v_definition) = 0 THEN
    v_updated := replace(v_definition, '(''hero_release'',10,60),',
      '(''hero_release'',10,60),(''player_report'',5,300),');
    IF position('(''player_report'',5,300)' IN v_updated) = 0 THEN
      RAISE EXCEPTION 'player_report_rate_limit_patch_failed';
    END IF;
    EXECUTE v_updated;
  END IF;
END
$$;

-- Control Center: the opaque reference of a reported account. A different label
-- from the risk queue, so the two references never coincide.
CREATE OR REPLACE FUNCTION admin.player_report_ref(p_player_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT left(encode(sha256(convert_to('heroloop-player-report:' || p_player_id::text, 'UTF8')), 'hex'), 20)
$function$;

-- Founder report queue: one row per reported account over a clamped 1-90 day
-- window, most reported first. Counts, reasons, distinct reporters, first and
-- last report and the five newest comments. Never a player id, name, mail or
-- wallet, and never who reported.
CREATE OR REPLACE FUNCTION admin.player_report_list(p_days integer DEFAULT 30, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90));
  v_reports bigint;
  v_targets bigint;
  v_reasons jsonb;
  v_rows jsonb;
BEGIN
  SELECT count(*), count(DISTINCT target_id) INTO v_reports, v_targets
  FROM public.player_reports WHERE created_at >= v_since;

  SELECT coalesce(jsonb_object_agg(reason, reports), '{}'::jsonb) INTO v_reasons
  FROM (SELECT reason, count(*) AS reports FROM public.player_reports WHERE created_at >= v_since GROUP BY reason) r;

  SELECT coalesce(jsonb_agg(row_data ORDER BY reports DESC, last_at DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT
      count(*) AS reports,
      max(p.created_at) AS last_at,
      jsonb_build_object(
        'ref', admin.player_report_ref(p.target_id),
        'reports', count(*),
        'reporters', count(DISTINCT p.reporter_id),
        'reasons', (SELECT jsonb_object_agg(x.reason, x.n) FROM (
          SELECT reason, count(*) AS n FROM public.player_reports
          WHERE target_id = p.target_id AND created_at >= v_since GROUP BY reason) x),
        'first_at', min(p.created_at),
        'last_at', max(p.created_at),
        'comments', coalesce((SELECT jsonb_agg(jsonb_build_object('reason', c.reason, 'comment', c.comment, 'at', c.created_at) ORDER BY c.created_at DESC)
          FROM (SELECT reason, comment, created_at FROM public.player_reports
                WHERE target_id = p.target_id AND created_at >= v_since AND comment IS NOT NULL
                ORDER BY created_at DESC LIMIT 5) c), '[]'::jsonb)
      ) AS row_data
    FROM public.player_reports p
    WHERE p.created_at >= v_since
    GROUP BY p.target_id
    ORDER BY count(*) DESC, max(p.created_at) DESC
    LIMIT v_limit
  ) q;

  RETURN jsonb_build_object(
    'version', 'player-reports.v1',
    'as_of', now(),
    'timezone', 'UTC',
    'window_days', v_days,
    'reports', v_reports,
    'reported_players', v_targets,
    'reasons', v_reasons,
    'limit', v_limit,
    'truncated', v_targets > v_limit,
    'rows', v_rows
  );
END
$function$;

-- The reference back to an account id, only while that account has a report in
-- the last 90 days. The BFF passes the id straight to admin.player_support_find.
CREATE OR REPLACE FUNCTION admin.player_report_resolve(p_ref text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT p.target_id FROM public.player_reports p
  WHERE p_ref ~ '^[0-9a-f]{20}$' AND p.created_at >= now() - interval '90 days'
    AND admin.player_report_ref(p.target_id) = p_ref
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION admin.player_report_ref(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_list(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_report_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.player_report_list(integer, integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.player_report_resolve(text) TO heroloop_admin;

COMMENT ON FUNCTION admin.player_report_list(integer, integer) IS
  'Founder report queue: one row per reported account (counts, reasons, distinct reporters, first/last, five newest comments, opaque ref); never an id, name, mail, wallet or reporter.';
COMMENT ON FUNCTION admin.player_report_resolve(text) IS
  'Resolves a report ref to its account id while the account has a report in the last 90 days; used only to open it through Player Support.';
