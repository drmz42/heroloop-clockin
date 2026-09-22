-- Stop pre-launch economy telemetry and clear only identifier-free aggregate output.
-- Authoritative player, save, item, chest, currency and settlement records are preserved.

DO $deferral$
DECLARE
  v_environment text;
  v_enabled boolean;
  v_observed_enabled boolean;
BEGIN
  SELECT environment, enabled, observed_gold_enabled
    INTO v_environment, v_enabled, v_observed_enabled
  FROM telemetry.economy_collector_settings WHERE singleton FOR UPDATE;

  IF v_environment = 'production' AND (v_enabled OR v_observed_enabled) THEN
    RAISE EXCEPTION 'economy telemetry must remain disabled on Production';
  ELSIF v_environment = 'staging' THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('economy-telemetry-hourly', 'observed-gold-hourly');

    UPDATE telemetry.economy_collector_settings
    SET enabled = false,
      observed_gold_enabled = false,
      observed_gold_activated_at = NULL,
      observed_gold_first_full_day = NULL,
      updated_at = clock_timestamp()
    WHERE singleton;

    DELETE FROM telemetry.economy_rollups;
  END IF;
END
$deferral$;

COMMENT ON TABLE telemetry.economy_rollups IS
  'Identifier-free aggregate output; empty and deferred until a reviewed public-launch activation.';
