\set ON_ERROR_STOP on

-- Player activity and host headroom over time.
--
-- The database keeps only the latest heartbeat, so "how many were playing last
-- Tuesday" cannot be answered from it, today or ever. The only honest fix is to
-- start recording: a timer takes a sample every few minutes and this table
-- keeps it. Nothing here is backfilled - the series simply begins on the day
-- collection started, and the panel says so rather than drawing a line through
-- a period nobody measured.
--
-- A sample is counts only: how many were online, how many were seen in the last
-- day, how many players exist, and how much room the machine had. No row here
-- says anything about a person.

CREATE TABLE IF NOT EXISTS admin.activity_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  online_now integer NOT NULL,
  active_24h integer NOT NULL,
  players_total integer NOT NULL,
  disk_free_pct numeric,
  memory_free_pct numeric
);

CREATE INDEX IF NOT EXISTS activity_samples_sampled_at_idx ON admin.activity_samples(sampled_at DESC);

COMMENT ON TABLE admin.activity_samples IS
  'Periodic counts of online and recently seen players plus host headroom, so the panel can draw a history the game tables cannot reconstruct. Counts only.';

-- Called by the sampler timer. The player counts are read here rather than
-- passed in, so the numbers cannot be shaped by whoever calls it; only the host
-- figures, which the database cannot see, come from the caller.
CREATE OR REPLACE FUNCTION admin.record_activity_sample(
  p_disk_free_pct numeric DEFAULT NULL,
  p_memory_free_pct numeric DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_online integer;
  v_active integer;
  v_total integer;
BEGIN
  SELECT count(*) FILTER (WHERE online AND last_heartbeat >= now() - interval '5 minutes'),
         count(*) FILTER (WHERE last_heartbeat >= now() - interval '24 hours'),
         count(*)
    INTO v_online, v_active, v_total
  FROM public.players;

  INSERT INTO admin.activity_samples(online_now, active_24h, players_total, disk_free_pct, memory_free_pct)
  VALUES (v_online, v_active, v_total,
          least(greatest(p_disk_free_pct, 0), 100),
          least(greatest(p_memory_free_pct, 0), 100));

  RETURN jsonb_build_object('online_now', v_online, 'active_24h', v_active, 'players_total', v_total);
END
$function$;

REVOKE ALL ON FUNCTION admin.record_activity_sample(numeric, numeric) FROM PUBLIC;
GRANT SELECT ON admin.activity_samples TO heroloop_admin;

-- Replaces the series from 20260924190000: the same facts plus the recorded
-- activity, host headroom and account deletions. A day with no sample is null,
-- never zero - "nobody was playing" and "nobody was counting" must not look
-- alike on a chart.
CREATE OR REPLACE FUNCTION admin.timeseries(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from date := (now() AT TIME ZONE 'UTC')::date - (v_days - 1);
  v_series jsonb := '{}'::jsonb;
  v_since timestamptz;
BEGIN
  SELECT min(sampled_at) INTO v_since FROM admin.activity_samples;

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
  ),
  deletions AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM admin.account_deletions WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  activity AS (
    SELECT (sampled_at AT TIME ZONE 'UTC')::date AS day,
           max(online_now) AS online_peak,
           max(active_24h) AS active_24h,
           round(min(disk_free_pct), 1) AS disk_free_pct,
           round(min(memory_free_pct), 1) AS memory_free_pct
    FROM admin.activity_samples
    WHERE (sampled_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
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
    'admin_refusals', coalesce(jsonb_agg(coalesce(a.refused, 0) ORDER BY d.day), '[]'::jsonb),
    'account_deletions', coalesce(jsonb_agg(coalesce(del.n, 0) ORDER BY d.day), '[]'::jsonb),
    'online_peak', coalesce(jsonb_agg(act.online_peak ORDER BY d.day), '[]'::jsonb),
    'active_24h', coalesce(jsonb_agg(act.active_24h ORDER BY d.day), '[]'::jsonb),
    'disk_free_pct', coalesce(jsonb_agg(act.disk_free_pct ORDER BY d.day), '[]'::jsonb),
    'memory_free_pct', coalesce(jsonb_agg(act.memory_free_pct ORDER BY d.day), '[]'::jsonb)
  ) INTO v_series
  FROM days d
  LEFT JOIN signups s ON s.day = d.day
  LEFT JOIN issuance i ON i.day = d.day
  LEFT JOIN summons su ON su.day = d.day
  LEFT JOIN risk r ON r.day = d.day
  LEFT JOIN audit a ON a.day = d.day
  LEFT JOIN deletions del ON del.day = d.day
  LEFT JOIN activity act ON act.day = d.day;

  RETURN jsonb_build_object(
    'version', 'timeseries.v2',
    'as_of', now(),
    'timezone', 'UTC',
    'days_requested', v_days,
    'series', v_series,
    'activity_collecting_since', v_since,
    'not_tracked', CASE WHEN v_since IS NULL
      THEN jsonb_build_array('daily_active_players', 'concurrent_players')
      ELSE jsonb_build_array() END
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.timeseries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.timeseries(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.timeseries(integer) IS
  'Daily series for the control center charts. Counted facts are zero-filled; recorded activity and host headroom are null on days with no sample, because an unmeasured day must not look like a quiet one.';
