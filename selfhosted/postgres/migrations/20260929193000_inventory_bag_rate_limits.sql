-- Register the two Bag actions in the private command rate limiter.
-- The first Bag migration intentionally did not alter its existing limits.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''shop_bundle_buy'',10,60),',
    '(''shop_bundle_buy'',10,60),(''inventory_bag_quote'',30,60),(''inventory_bag_buy'',10,60),');
  IF v_updated = v_definition OR position('(''inventory_bag_quote'',30,60)' IN v_updated) = 0
    OR position('(''inventory_bag_buy'',10,60)' IN v_updated) = 0 THEN
    RAISE EXCEPTION 'inventory_bag_rate_limit_patch_failed';
  END IF;
  EXECUTE v_updated;
END;
$$;
