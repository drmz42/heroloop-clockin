-- Preserve the accepted collectors but defer collection until public game launch.
-- No aggregate data is deleted; a future reviewed activation must start a new full-UTC-day window.

DO $deferral$
DECLARE
  v_environment text;
  v_observed_enabled boolean;
BEGIN
  SELECT environment, observed_gold_enabled
    INTO v_environment, v_observed_enabled
  FROM telemetry.economy_collector_settings WHERE singleton FOR UPDATE;

  IF v_environment = 'production' AND v_observed_enabled THEN
    RAISE EXCEPTION 'observed Gold must remain disabled on Production';
  ELSIF v_environment = 'staging' THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'observed-gold-hourly';
    UPDATE telemetry.economy_collector_settings
    SET observed_gold_enabled = false,
      observed_gold_activated_at = NULL,
      observed_gold_first_full_day = NULL,
      updated_at = clock_timestamp()
    WHERE singleton;
  END IF;
END
$deferral$;

COMMENT ON FUNCTION telemetry.run_observed_gold_collection_windowed(timestamptz) IS
  'Implemented private collector, deferred until a reviewed public-launch activation starts a new full-day window.';
