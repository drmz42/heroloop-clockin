-- Stage 4: install disabled hourly orchestration, identifier-free daily rollups,
-- bounded retention and a private operator query. Stage 5 owns Staging activation.

CREATE OR REPLACE FUNCTION telemetry.rollup_economy_day(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_enabled boolean;
  v_environment text;
  v_rows integer := 0;
  v_added integer;
BEGIN
  SELECT enabled, environment INTO v_enabled, v_environment
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RAISE EXCEPTION 'economy_collectors_disabled'; END IF;
  IF p_day IS NULL OR p_day >= (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'economy_rollup_requires_completed_utc_day';
  END IF;

  DELETE FROM telemetry.economy_rollups
  WHERE period_kind = 'day' AND bucket_start_utc = p_day::timestamp
    AND environment = v_environment;

  -- Event-style aggregates are additive. cohort_accounts is an identifier-free
  -- lower bound (the largest accepted hourly cohort), never a cross-hour user count.
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, inventory_fill_band, currency, progression_kind,
    resource_kind, flow_direction, activity_mode, chest_kind, rarity, source_kind,
    metric_value, cohort_accounts
  )
  SELECT 'day', p_day::timestamp, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, inventory_fill_band, currency, progression_kind,
    resource_kind, flow_direction, activity_mode, chest_kind, rarity, source_kind,
    sum(metric_value), max(cohort_accounts)
  FROM telemetry.economy_rollups
  WHERE period_kind = 'hour' AND environment = v_environment
    AND bucket_start_utc >= p_day::timestamp
    AND bucket_start_utc < p_day::timestamp + interval '1 day'
    AND aggregate_id NOT IN ('inventory_saturation', 'currency_balance')
  GROUP BY environment, balance_version, aggregate_id, metric_id, account_level_band,
    item_level_band, inventory_fill_band, currency, progression_kind, resource_kind,
    flow_direction, activity_mode, chest_kind, rarity, source_kind;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_rows := v_rows + v_added;

  -- Stock/snapshot aggregates use the last available accepted hourly sample;
  -- summing balances or Inventory samples across a day would over-count accounts.
  WITH latest AS (
    SELECT DISTINCT ON (
      environment, balance_version, aggregate_id, metric_id, account_level_band,
      item_level_band, inventory_fill_band, currency, progression_kind, resource_kind,
      flow_direction, activity_mode, chest_kind, rarity, source_kind
    ) environment, balance_version, aggregate_id, metric_id, account_level_band,
      item_level_band, inventory_fill_band, currency, progression_kind, resource_kind,
      flow_direction, activity_mode, chest_kind, rarity, source_kind,
      metric_value, cohort_accounts
    FROM telemetry.economy_rollups
    WHERE period_kind = 'hour' AND environment = v_environment
      AND bucket_start_utc >= p_day::timestamp
      AND bucket_start_utc < p_day::timestamp + interval '1 day'
      AND aggregate_id IN ('inventory_saturation', 'currency_balance')
    ORDER BY environment, balance_version, aggregate_id, metric_id, account_level_band,
      item_level_band, inventory_fill_band, currency, progression_kind, resource_kind,
      flow_direction, activity_mode, chest_kind, rarity, source_kind, bucket_start_utc DESC
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, inventory_fill_band, currency, progression_kind,
    resource_kind, flow_direction, activity_mode, chest_kind, rarity, source_kind,
    metric_value, cohort_accounts
  )
  SELECT 'day', p_day::timestamp, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, inventory_fill_band, currency, progression_kind,
    resource_kind, flow_direction, activity_mode, chest_kind, rarity, source_kind,
    metric_value, cohort_accounts
  FROM latest;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_rows + v_added;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry.prune_economy_rollups(p_requested_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_hour_rows integer;
  v_day_rows integer;
BEGIN
  IF p_requested_at IS NULL OR p_requested_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_economy_retention_tick';
  END IF;
  DELETE FROM telemetry.economy_rollups
  WHERE period_kind = 'hour'
    AND bucket_start_utc < date_trunc('hour', p_requested_at AT TIME ZONE 'UTC') - interval '14 days';
  GET DIAGNOSTICS v_hour_rows = ROW_COUNT;
  DELETE FROM telemetry.economy_rollups
  WHERE period_kind = 'day'
    AND bucket_start_utc < date_trunc('day', p_requested_at AT TIME ZONE 'UTC') - interval '180 days';
  GET DIAGNOSTICS v_day_rows = ROW_COUNT;
  RETURN jsonb_build_object('hour_rows', v_hour_rows, 'day_rows', v_day_rows);
END;
$$;

CREATE OR REPLACE FUNCTION telemetry.query_economy_rollups(
  p_environment text,
  p_period_kind text,
  p_from timestamptz,
  p_to timestamptz,
  p_balance_version text DEFAULT NULL,
  p_aggregate_id text DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS SETOF telemetry.economy_rollups
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_max_range interval;
BEGIN
  IF p_environment NOT IN ('staging', 'production')
    OR p_period_kind NOT IN ('hour', 'day')
    OR p_from IS NULL OR p_to IS NULL OR p_from >= p_to
    OR p_to > now() + interval '5 minutes'
    OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_economy_query';
  END IF;
  v_max_range := CASE WHEN p_period_kind = 'hour' THEN interval '14 days' ELSE interval '180 days' END;
  IF p_to - p_from > v_max_range THEN RAISE EXCEPTION 'economy_query_range_exceeds_retention'; END IF;

  RETURN QUERY
  SELECT rollup.* FROM telemetry.economy_rollups rollup
  WHERE rollup.environment = p_environment
    AND rollup.period_kind = p_period_kind
    AND rollup.bucket_start_utc >= p_from AT TIME ZONE 'UTC'
    AND rollup.bucket_start_utc < p_to AT TIME ZONE 'UTC'
    AND (p_balance_version IS NULL OR rollup.balance_version = p_balance_version)
    AND (p_aggregate_id IS NULL OR rollup.aggregate_id = p_aggregate_id)
  ORDER BY rollup.bucket_start_utc DESC, rollup.aggregate_id, rollup.metric_id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry.run_economy_collection(p_requested_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_enabled boolean;
  v_tick timestamptz;
  v_completed_hour timestamptz;
  v_currency_rows integer;
  v_distribution_rows integer;
  v_snapshot_rows integer;
  v_daily_rows integer := 0;
  v_pruned jsonb;
BEGIN
  IF p_requested_at IS NULL OR p_requested_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_economy_collection_tick';
  END IF;
  v_tick := date_trunc('hour', p_requested_at);
  v_completed_hour := v_tick - interval '1 hour';
  v_pruned := telemetry.prune_economy_rollups(p_requested_at);
  SELECT enabled INTO v_enabled FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN jsonb_build_object('status', 'disabled', 'pruned', v_pruned);
  END IF;

  v_currency_rows := telemetry.collect_currency_settlement_hour(v_completed_hour);
  v_distribution_rows := telemetry.collect_loot_chest_hour(v_completed_hour);
  v_snapshot_rows := telemetry.collect_economy_snapshot(v_tick);
  IF extract(hour FROM v_tick) = 0 THEN
    v_daily_rows := telemetry.rollup_economy_day((v_tick AT TIME ZONE 'UTC')::date - 1);
  END IF;
  RETURN jsonb_build_object(
    'status', 'collected', 'completed_hour', v_completed_hour,
    'currency_rows', v_currency_rows, 'distribution_rows', v_distribution_rows,
    'snapshot_rows', v_snapshot_rows, 'daily_rows', v_daily_rows, 'pruned', v_pruned
  );
END;
$$;

REVOKE ALL ON FUNCTION telemetry.rollup_economy_day(date)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.prune_economy_rollups(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.query_economy_rollups(text, text, timestamptz, timestamptz, text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.run_economy_collection(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'economy-telemetry-hourly';

SELECT cron.schedule(
  'economy-telemetry-hourly',
  '5 * * * *',
  $cron$SELECT telemetry.run_economy_collection(clock_timestamp());$cron$
);

COMMENT ON FUNCTION telemetry.rollup_economy_day(date) IS
  'Private identifier-free UTC daily rollup; event metrics sum and stock metrics retain the final hourly sample.';
COMMENT ON FUNCTION telemetry.prune_economy_rollups(timestamptz) IS
  'Private retention boundary: hourly aggregates 14 days and daily aggregates 180 days.';
COMMENT ON FUNCTION telemetry.query_economy_rollups(text, text, timestamptz, timestamptz, text, text, integer) IS
  'Private bounded operator query with no browser, API, service-role or worker grant.';
COMMENT ON FUNCTION telemetry.run_economy_collection(timestamptz) IS
  'Hourly private orchestrator; installed scheduled but returns disabled until the root collector gate is activated.';
