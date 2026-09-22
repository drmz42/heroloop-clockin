-- Activate identifier-free observed-Gold collection only on exact-version VPS1 Staging.
-- The activation day is deliberately excluded; acceptance begins with the next full UTC day.

ALTER TABLE telemetry.economy_collector_settings
  ADD COLUMN observed_gold_activated_at timestamptz,
  ADD COLUMN observed_gold_first_full_day date,
  ADD CONSTRAINT observed_gold_activation_boundary CHECK (
    NOT observed_gold_enabled OR (
      observed_gold_activated_at IS NOT NULL
      AND observed_gold_first_full_day = (observed_gold_activated_at AT TIME ZONE 'UTC')::date + 1
    )
  );

CREATE OR REPLACE FUNCTION telemetry.run_observed_gold_collection_windowed(p_requested_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_enabled boolean;
  v_first_full_day date;
  v_tick timestamptz;
  v_completed_hour timestamptz;
  v_completed_day date;
  v_hour_rows integer := 0;
  v_day_rows integer := 0;
BEGIN
  IF p_requested_at IS NULL OR p_requested_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_economy_collection_tick';
  END IF;
  SELECT enabled AND observed_gold_enabled, observed_gold_first_full_day
    INTO v_enabled, v_first_full_day
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN jsonb_build_object('status', 'disabled'); END IF;
  IF v_first_full_day IS NULL THEN RAISE EXCEPTION 'observed_gold_start_boundary_missing'; END IF;

  v_tick := date_trunc('hour', p_requested_at);
  v_completed_hour := v_tick - interval '1 hour';
  v_completed_day := (v_tick AT TIME ZONE 'UTC')::date - 1;
  IF v_completed_hour::date >= v_first_full_day THEN
    v_hour_rows := telemetry.collect_gold_grant_hour(v_completed_hour);
  END IF;
  IF extract(hour FROM v_tick) = 0 AND v_completed_day >= v_first_full_day THEN
    PERFORM telemetry.rollup_economy_day(v_completed_day);
    v_day_rows := telemetry.collect_observed_gold_day(v_completed_day);
  END IF;
  RETURN jsonb_build_object(
    'status', CASE WHEN v_tick::date < v_first_full_day THEN 'waiting_full_utc_day' ELSE 'collected' END,
    'first_full_utc_day', v_first_full_day,
    'completed_hour', v_completed_hour,
    'hour_rows', v_hour_rows,
    'day_rows', v_day_rows
  );
END;
$$;
REVOKE ALL ON FUNCTION telemetry.run_observed_gold_collection_windowed(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION telemetry.run_observed_gold_collection(p_requested_at timestamptz)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, telemetry
SET timezone = 'UTC'
AS $$
  SELECT telemetry.run_observed_gold_collection_windowed(p_requested_at)
$$;
REVOKE ALL ON FUNCTION telemetry.run_observed_gold_collection(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

DO $activation$
DECLARE
  v_environment text;
  v_balance_version text;
  v_observed_enabled boolean;
  v_activated_at timestamptz := clock_timestamp();
BEGIN
  SELECT environment, balance_version, observed_gold_enabled
    INTO v_environment, v_balance_version, v_observed_enabled
  FROM telemetry.economy_collector_settings WHERE singleton FOR UPDATE;

  IF v_environment = 'production' AND v_observed_enabled THEN
    RAISE EXCEPTION 'observed Gold must remain disabled on Production';
  ELSIF v_environment = 'staging' THEN
    IF v_balance_version <> 'balance-v4-2026.09.06-v7-combat-effects-v2-candidate' THEN
      RAISE EXCEPTION 'unexpected Staging balance version for observed Gold activation';
    END IF;
    UPDATE telemetry.economy_collector_settings
    SET observed_gold_enabled = true,
      observed_gold_activated_at = v_activated_at,
      observed_gold_first_full_day = (v_activated_at AT TIME ZONE 'UTC')::date + 1,
      updated_at = v_activated_at
    WHERE singleton;

    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'observed-gold-hourly';
    PERFORM cron.schedule(
      'observed-gold-hourly',
      '10 * * * *',
      $cron$SELECT telemetry.run_observed_gold_collection_windowed(clock_timestamp());$cron$
    );
  END IF;
END
$activation$;

COMMENT ON FUNCTION telemetry.run_observed_gold_collection_windowed(timestamptz) IS
  'Private Staging-only observed-Gold orchestrator; excludes activation-day and all earlier buckets.';
COMMENT ON FUNCTION telemetry.run_observed_gold_collection(timestamptz) IS
  'Compatibility entry point routed through the no-backfill full-UTC-day boundary.';
