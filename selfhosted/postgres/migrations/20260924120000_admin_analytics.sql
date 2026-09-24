\set ON_ERROR_STOP on

-- Analytics read model for the Founder Control Center
-- (docs/game/admin-analytics-proposal.md, docs/game/founder-control-center-v2-tz.md).
--
-- Versioned aggregate: funnel, weekly sign-up cohorts, a "still seen after day N"
-- measure and level segments, all in UTC and all over server-owned columns
-- (auth sign-up time, the server-written players row). Never a per-player row.
--
-- Small-cohort suppression lives here, not in the UI: any count below the
-- threshold is returned as NULL with a suppressed flag, so no client can
-- recover it. Retention is *not* a D1/D7/D30 curve: the database keeps only the
-- latest heartbeat, so the honest question is whether an account was last seen
-- on or after day N. A cohort that has not fully reached day N is withheld
-- rather than counted as churn.
--
-- LTV/ARPU and A/B results have no revenue or experiment source yet and are
-- returned as 'not_connected', never as zero.

CREATE OR REPLACE FUNCTION admin.analytics_summary(p_min_cohort integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_min integer := least(greatest(coalesce(p_min_cohort, 5), 5), 1000);
  v_now timestamptz := now();
  v_funnel jsonb;
  v_cohorts jsonb;
  v_segments jsonb;
  v_accounts bigint;
  v_players bigint;
BEGIN
  SELECT count(*) INTO v_accounts FROM auth.users;
  SELECT count(*) INTO v_players FROM public.players;

  -- Ordered, cumulative steps. Tutorial has no server column, so it is named as
  -- untracked instead of being inferred from a neighbouring step.
  SELECT jsonb_build_array(
    jsonb_build_object('key', 'registered', 'count', CASE WHEN v_accounts >= v_min THEN v_accounts END, 'suppressed', v_accounts < v_min),
    jsonb_build_object('key', 'tutorial', 'count', NULL, 'suppressed', false, 'state', 'not_tracked'),
    jsonb_build_object('key', 'first_battle', 'count', CASE WHEN c.b >= v_min THEN c.b END, 'suppressed', c.b < v_min),
    jsonb_build_object('key', 'first_chest', 'count', CASE WHEN c.c >= v_min THEN c.c END, 'suppressed', c.c < v_min),
    jsonb_build_object('key', 'first_summon', 'count', CASE WHEN c.s >= v_min THEN c.s END, 'suppressed', c.s < v_min)
  ) INTO v_funnel
  FROM (
    SELECT count(*) FILTER (WHERE total_kills > 0) AS b,
           count(*) FILTER (WHERE chests_opened > 0) AS c,
           count(*) FILTER (WHERE summons > 0) AS s
    FROM public.players
  ) c;

  -- Last eight whole UTC weeks plus the current one: well inside the 180-day
  -- lookback cap. Day-N counts need the whole cohort to have reached day N.
  WITH weeks AS (
    SELECT generate_series(
      date_trunc('week', (v_now AT TIME ZONE 'UTC')) - interval '8 weeks',
      date_trunc('week', (v_now AT TIME ZONE 'UTC')),
      interval '1 week'
    ) AS week_start
  ), cohort AS (
    SELECT w.week_start,
           count(u.id) AS size,
           count(p.player_id) AS played,
           count(*) FILTER (WHERE p.last_heartbeat >= u.created_at + interval '1 day') AS d1,
           count(*) FILTER (WHERE p.last_heartbeat >= u.created_at + interval '7 days') AS d7,
           count(*) FILTER (WHERE p.last_heartbeat >= u.created_at + interval '30 days') AS d30
    FROM weeks w
    LEFT JOIN auth.users u
      ON (u.created_at AT TIME ZONE 'UTC') >= w.week_start
     AND (u.created_at AT TIME ZONE 'UTC') < w.week_start + interval '1 week'
    LEFT JOIN public.players p ON p.player_id = u.id
    GROUP BY w.week_start
  )
  SELECT coalesce(jsonb_agg(
    CASE WHEN c.size < v_min THEN
      jsonb_build_object('week_start', to_char(c.week_start, 'YYYY-MM-DD'), 'suppressed', true,
                         'size', NULL, 'played', NULL, 'd1', NULL, 'd7', NULL, 'd30', NULL)
    ELSE
      jsonb_build_object(
        'week_start', to_char(c.week_start, 'YYYY-MM-DD'), 'suppressed', false,
        'size', c.size,
        'played', CASE WHEN c.played >= v_min THEN c.played END,
        'd1', CASE WHEN c.week_start + interval '1 week' + interval '1 day' <= (v_now AT TIME ZONE 'UTC') AND c.d1 >= v_min THEN c.d1 END,
        'd7', CASE WHEN c.week_start + interval '1 week' + interval '7 days' <= (v_now AT TIME ZONE 'UTC') AND c.d7 >= v_min THEN c.d7 END,
        'd30', CASE WHEN c.week_start + interval '1 week' + interval '30 days' <= (v_now AT TIME ZONE 'UTC') AND c.d30 >= v_min THEN c.d30 END,
        'mature_d1', c.week_start + interval '1 week' + interval '1 day' <= (v_now AT TIME ZONE 'UTC'),
        'mature_d7', c.week_start + interval '1 week' + interval '7 days' <= (v_now AT TIME ZONE 'UTC'),
        'mature_d30', c.week_start + interval '1 week' + interval '30 days' <= (v_now AT TIME ZONE 'UTC')
      )
    END
    ORDER BY c.week_start DESC), '[]'::jsonb)
  INTO v_cohorts FROM cohort c;

  -- Segments by account level band, players only.
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'band', s.band,
      'players', CASE WHEN s.n >= v_min THEN s.n END,
      'active_7d', CASE WHEN s.n >= v_min AND s.a >= v_min THEN s.a END,
      'suppressed', s.n < v_min
    ) ORDER BY s.ord), '[]'::jsonb)
  INTO v_segments
  FROM (
    SELECT b.ord, b.band, count(p.player_id) AS n,
           count(*) FILTER (WHERE p.last_heartbeat >= v_now - interval '7 days') AS a
    FROM (VALUES (1, '1-9', 1, 9), (2, '10-24', 10, 24), (3, '25-49', 25, 49), (4, '50+', 50, 2147483647)) AS b(ord, band, lo, hi)
    LEFT JOIN public.players p ON p.account_level BETWEEN b.lo AND b.hi
    GROUP BY b.ord, b.band
  ) s;

  RETURN jsonb_build_object(
    'version', 'analytics.v1',
    'as_of', v_now,
    'timezone', 'UTC',
    'min_cohort', v_min,
    'coverage', jsonb_build_object(
      'accounts', v_accounts,
      'players', v_players,
      'lookback_days', 63,
      'source', 'auth sign-up time and the server-written players row',
      'retention_measure', 'last_seen_on_or_after_day_n'
    ),
    'funnel', v_funnel,
    'cohorts', v_cohorts,
    'segments', v_segments,
    'ltv_arpu', 'not_connected',
    'ab_results', 'not_connected'
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.analytics_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.analytics_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.analytics_summary(integer) IS
  'Versioned aggregate-only Analytics read for the Founder Control Center: funnel, weekly cohorts, last-seen retention and level segments with small-cohort suppression; never a per-player row, never a write.';
