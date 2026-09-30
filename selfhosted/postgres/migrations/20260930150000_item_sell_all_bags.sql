-- Sell all covers every unlocked item in all four bags (4 x 64 = 256 cells).
-- Raise only the item count bound of the established item settlement; lock stays single-item.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.settle_item_mutation(uuid,uuid,text,uuid[],boolean)'::regprocedure);
  v_new := replace(v_def, 'NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION ''invalid_item_count''', 'NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION ''invalid_item_count''');
  IF v_def = v_new THEN RAISE EXCEPTION 'item_sell_all_bags_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;
