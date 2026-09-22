BEGIN;

GRANT SELECT ON TABLE public.token_spend_events TO service_role;

COMMIT;
