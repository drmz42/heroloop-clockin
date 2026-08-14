\set ON_ERROR_STOP on

DO $migration$
DECLARE
  managed_job_id bigint;
BEGIN
  FOR managed_job_id IN
    SELECT jobid FROM cron.job WHERE jobname = 'token-distribution-30-seconds'
  LOOP
    PERFORM cron.unschedule(managed_job_id);
  END LOOP;
END
$migration$;

COMMENT ON FUNCTION public.verify_token_distribution_cron_secret(text) IS
  'Legacy Supabase HTTP-cron verifier retained for restored-schema compatibility; the self-hosted worker never calls it.';
