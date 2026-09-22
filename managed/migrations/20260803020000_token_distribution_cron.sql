CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'token_distribution_cron_secret'
  ) THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'token_distribution_cron_secret',
      'Authenticates the internal 30-second token distribution cron.'
    );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_token_distribution_cron_secret(candidate text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM vault.decrypted_secrets
    WHERE name = 'token_distribution_cron_secret'
      AND decrypted_secret = candidate
  );
$$;

REVOKE ALL ON FUNCTION public.verify_token_distribution_cron_secret(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_token_distribution_cron_secret(text) TO service_role;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'token-distribution-30-seconds';

SELECT cron.schedule(
  'token-distribution-30-seconds',
  '30 seconds',
  $cron$
    SELECT net.http_post(
      url := 'https://fnbyxbxdjcsrqivycuja.supabase.co/functions/v1/token-distribution',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'token_distribution_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $cron$
);
