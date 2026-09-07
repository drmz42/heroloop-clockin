\set ON_ERROR_STOP on

-- Hero Release adds a new rate-limited API action. Preserve the later shared
-- Staging Tester allowance while extending the older explicit action table.
DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''tester_credit_tokens'',5,60)', '(''tester_credit_tokens'',10,60)');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'tester_rate_limit_restore_failed'; END IF;
  EXECUTE v_updated;
END;
$$;
