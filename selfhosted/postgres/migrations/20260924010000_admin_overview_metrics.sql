\set ON_ERROR_STOP on

-- Overview read model for the Founder Control Center
-- (config/admin-analytics.v1.json, docs/game/founder-control-center-v2-tz.md).
--
-- Aggregates only: counts and shares over whole tables, never a per-player row,
-- so the Overview screen cannot become a way to read one account. Every number
-- comes from server-owned state (auth sign-up times and the server-written
-- players row), never from anything a client reported about itself.
--
-- What is deliberately absent: tutorial completion, a real per-cohort retention
-- curve and concurrent-player history need event telemetry this database does
-- not keep. They stay "not tracked" in the response so the screen can say so,
-- instead of a plausible number with nothing behind it.

CREATE OR REPLACE FUNCTION admin.overview_metrics(p_min_cohort integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  -- Shares are withheld for a cohort smaller than this: with a handful of
  -- accounts a percentage describes individuals, not a trend.
  v_min_cohort integer := least(greatest(coalesce(p_min_cohort, 5), 1), 1000);
  -- A client that disappears leaves `online` set, so "now" means a heartbeat
  -- the server itself wrote in the last five minutes.
  v_online_within interval := interval '5 minutes';
  v_accounts jsonb;
  v_players jsonb;
  v_funnel jsonb;
  v_cohort bigint;
  v_cohort_active bigint;
  v_retention jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total', count(*),
    'new_24h', count(*) FILTER (WHERE created_at >= now() - interval '24 hours'),
    'new_7d', count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
    'new_30d', count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    'first_at', min(created_at),
    'last_at', max(created_at)
  ) INTO v_accounts FROM auth.users;

  SELECT jsonb_build_object(
    'total', count(*),
    'online_now', count(*) FILTER (WHERE online AND last_heartbeat >= now() - v_online_within),
    'active_24h', count(*) FILTER (WHERE last_heartbeat >= now() - interval '24 hours'),
    'active_7d', count(*) FILTER (WHERE last_heartbeat >= now() - interval '7 days'),
    'active_30d', count(*) FILTER (WHERE last_heartbeat >= now() - interval '30 days'),
    'last_activity_at', max(last_heartbeat)
  ) INTO v_players FROM public.players;

  -- Cumulative, not windowed: how far accounts have ever got, counted from the
  -- server's own progression columns. Tutorial completion has no column, so it
  -- is reported as untracked rather than inferred from something adjacent.
  SELECT jsonb_build_object(
    'accounts', (SELECT count(*) FROM auth.users),
    'players', count(*),
    'first_battle', count(*) FILTER (WHERE total_kills > 0),
    'first_chest', count(*) FILTER (WHERE chests_opened > 0),
    'first_summon', count(*) FILTER (WHERE summons > 0),
    'tutorial', 'not_tracked'
  ) INTO v_funnel FROM public.players;

  -- Not a D1/D7 curve: without event history the honest question is how many
  -- accounts older than a day are still playing, so that is what is returned,
  -- under its own name.
  SELECT count(*), count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM public.players p
      WHERE p.player_id = u.id AND p.last_heartbeat >= now() - interval '7 days'
    )
  )
  INTO v_cohort, v_cohort_active
  FROM auth.users u
  WHERE u.created_at < now() - interval '24 hours'
    AND u.created_at >= now() - interval '30 days';

  v_retention := jsonb_build_object(
    'kind', 'accounts_1d_to_30d_still_active_7d',
    'cohort', v_cohort,
    'active', v_cohort_active,
    'share', CASE WHEN v_cohort >= v_min_cohort THEN round(v_cohort_active::numeric / v_cohort, 4) ELSE NULL END,
    'min_cohort', v_min_cohort,
    'cohort_curve', 'not_tracked'
  );

  RETURN jsonb_build_object(
    'as_of', now(),
    'accounts', v_accounts,
    'players', v_players,
    'funnel', v_funnel,
    'retention', v_retention,
    'concurrency_history', 'not_tracked'
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.overview_metrics(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.overview_metrics(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.overview_metrics(integer) IS
  'Aggregate-only Overview read for the Founder Control Center: account, activity, funnel and still-active counts, never a per-player row, never a write.';
