\set ON_ERROR_STOP on

-- Daily series for the Founder Control Center charts.
--
-- Every screen so far answers with one number: how many accounts, how much
-- $HERO, how many summons. A number tells you the level and hides the shape,
-- and the shape is what a person actually reads a panel for. This returns the
-- same facts bucketed by UTC day so they can be drawn.
--
-- Rules that hold for every series here. Days with nothing in them are present
-- with a zero rather than missing, so a gap in the chart means a quiet day and
-- never a hole in the data. Counts are over server-written timestamps only.
-- Nothing is per player: a series is a count or a sum, never a row about
-- someone. And what the database cannot answer is absent rather than flat:
-- there is no daily-active series here, because only the latest heartbeat is
-- stored and a made-up history would look exactly like a real one.

CREATE OR REPLACE FUNCTION admin.timeseries(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from date := (now() AT TIME ZONE 'UTC')::date - (v_days - 1);
  v_series jsonb := '{}'::jsonb;
BEGIN
  WITH days AS (
    SELECT generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day
  ),
  signups AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM auth.users WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  issuance AS (
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
           round(sum(amount) FILTER (WHERE flow = 'player_issuance'), 2) AS issued,
           round(sum(amount) FILTER (WHERE flow = 'treasury_inflow'), 2) AS treasury,
           count(*) AS entries
    FROM public.hero_economy_ledger
    WHERE (occurred_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  summons AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n, coalesce(sum(summon_count), 0) AS heroes
    FROM public.summon_events WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  risk AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM public.account_risk_events WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  audit AS (
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS n,
           count(*) FILTER (WHERE outcome = 'failure') AS refused
    FROM admin.audit_log WHERE (occurred_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  )
  SELECT jsonb_build_object(
    'days', coalesce(jsonb_agg(to_char(d.day, 'YYYY-MM-DD') ORDER BY d.day), '[]'::jsonb),
    'signups', coalesce(jsonb_agg(coalesce(s.n, 0) ORDER BY d.day), '[]'::jsonb),
    'tokens_issued', coalesce(jsonb_agg(coalesce(i.issued, 0) ORDER BY d.day), '[]'::jsonb),
    'tokens_to_treasury', coalesce(jsonb_agg(coalesce(i.treasury, 0) ORDER BY d.day), '[]'::jsonb),
    'ledger_entries', coalesce(jsonb_agg(coalesce(i.entries, 0) ORDER BY d.day), '[]'::jsonb),
    'summons', coalesce(jsonb_agg(coalesce(su.n, 0) ORDER BY d.day), '[]'::jsonb),
    'heroes_summoned', coalesce(jsonb_agg(coalesce(su.heroes, 0) ORDER BY d.day), '[]'::jsonb),
    'risk_changes', coalesce(jsonb_agg(coalesce(r.n, 0) ORDER BY d.day), '[]'::jsonb),
    'admin_actions', coalesce(jsonb_agg(coalesce(a.n, 0) ORDER BY d.day), '[]'::jsonb),
    'admin_refusals', coalesce(jsonb_agg(coalesce(a.refused, 0) ORDER BY d.day), '[]'::jsonb)
  ) INTO v_series
  FROM days d
  LEFT JOIN signups s ON s.day = d.day
  LEFT JOIN issuance i ON i.day = d.day
  LEFT JOIN summons su ON su.day = d.day
  LEFT JOIN risk r ON r.day = d.day
  LEFT JOIN audit a ON a.day = d.day;

  RETURN jsonb_build_object(
    'version', 'timeseries.v1',
    'as_of', now(),
    'timezone', 'UTC',
    'days_requested', v_days,
    'series', v_series,
    'not_tracked', jsonb_build_array('daily_active_players', 'concurrent_players')
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.timeseries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.timeseries(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.timeseries(integer) IS
  'Zero-filled daily series for the control center charts: sign-ups, $HERO issued and taken, ledger entries, summons, risk changes and admin actions. Counts and sums only, never a per-player row.';
