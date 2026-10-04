-- A short reveal and one revision retry can exceed ten requests per minute.
-- Keep the standard Summon bucket intact; only the Seeker Scroll route uses this bucket.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  IF position('(''seeker_scroll_summon'',60,60)' IN v_definition) > 0 THEN RETURN; END IF;
  v_updated := replace(v_definition, '(''hero_summon'',10,60)',
    '(''hero_summon'',10,60),(''seeker_scroll_summon'',60,60)');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'seeker_scroll_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END;
$$;
