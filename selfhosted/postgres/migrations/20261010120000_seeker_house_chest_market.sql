-- Seeker house Boss Chest supply (Founder 2026-10-09): the game-owned merchants of
-- 20261008010000 also list Boss Chest lots. A purchase from a merchant is quoted with
-- `house_seller: true`, so the wallet pays the whole amount to the fees treasury, as for
-- merchant items and heroes. `public.seeker_house_chest_market_seed(seed, lots, ...)` is
-- called once per seed tag by the operator; a repeated tag returns the first summary.
BEGIN;

DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('''kind'',''chest'',''seller_id'',v_listing.seller_id)||' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$  v_context:=v_context||jsonb_build_object('kind','chest','seller_id',v_listing.seller_id);$old$,
      $new$  v_context:=v_context||jsonb_build_object('kind','chest','seller_id',v_listing.seller_id)||CASE WHEN EXISTS
    (SELECT 1 FROM public.seeker_house_sellers h WHERE h.player_id=v_listing.seller_id) THEN jsonb_build_object('house_seller',true) ELSE '{}'::jsonb END;$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_house_chest_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Lots of p_min..p_max Boss Chests at p_cent_lo..p_cent_hi USD cents per chest.
CREATE OR REPLACE FUNCTION public.seeker_house_chest_market_seed(p_seed text, p_lots integer,
  p_min integer DEFAULT 1, p_max integer DEFAULT 5, p_cent_lo integer DEFAULT 2, p_cent_hi integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing jsonb; v_ids uuid[]; v_quantity integer; v_price integer; v_chests jsonb; v_chests_total integer := 0; i integer;
BEGIN
  IF p_seed IS NULL OR p_seed !~ '^[a-z0-9-]{3,64}$' OR p_lots NOT BETWEEN 1 AND 200
    OR p_min NOT BETWEEN 1 AND 100 OR p_max NOT BETWEEN p_min AND 100
    OR p_cent_lo NOT BETWEEN 1 AND 1000 OR p_cent_hi NOT BETWEEN p_cent_lo AND 1000 THEN
    RAISE EXCEPTION 'invalid_house_market_seed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('seeker-house-market-seed', 0));
  SELECT summary INTO v_existing FROM public.seeker_house_market_seeds WHERE seed = p_seed;
  IF FOUND THEN RETURN v_existing; END IF;
  SELECT array_agg(player_id ORDER BY player_id) INTO v_ids FROM public.seeker_house_sellers;
  IF v_ids IS NULL THEN RAISE EXCEPTION 'house_merchants_missing'; END IF;
  FOR i IN 1..p_lots LOOP
    v_quantity := p_min + floor(random() * (p_max - p_min + 1))::integer;
    v_price := v_quantity * (p_cent_lo + floor(random() * (p_cent_hi - p_cent_lo + 1))::integer);
    SELECT jsonb_agg(jsonb_build_object('stage', 1 + floor(random() * 10)::integer, 'boss', true)) INTO v_chests
      FROM generate_series(1, v_quantity);
    INSERT INTO public.market_chest_listings(seller_id, kind, chests, quantity, price, created_at)
      VALUES (v_ids[1 + floor(random() * cardinality(v_ids))::integer], 'boss', v_chests, v_quantity,
        LEAST(100000000, v_price), now() - random() * interval '24 hours');
    v_chests_total := v_chests_total + v_quantity;
  END LOOP;
  v_existing := jsonb_build_object('seed', p_seed, 'chest_lots', p_lots, 'chests', v_chests_total, 'merchants', cardinality(v_ids));
  INSERT INTO public.seeker_house_market_seeds(seed, summary) VALUES (p_seed, v_existing);
  RETURN v_existing;
END $$;
REVOKE ALL ON FUNCTION public.seeker_house_chest_market_seed(text, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;

COMMIT;
