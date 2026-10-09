-- Disposable game DB only: Boss Chest Market list, cancel, buy, replay and refusals.
\set ON_ERROR_STOP 1
INSERT INTO auth.users(instance_id,id,aud,role,created_at,updated_at) VALUES
  ('00000000-0000-0000-0000-000000000000','31000000-0000-4000-8000-000000000001','authenticated','authenticated',now(),now()),
  ('00000000-0000-0000-0000-000000000000','31000000-0000-4000-8000-000000000002','authenticated','authenticated',now(),now());
INSERT INTO public.players(player_id,username) VALUES
  ('31000000-0000-4000-8000-000000000001','ChestSeller'),('31000000-0000-4000-8000-000000000002','ChestBuyer');
INSERT INTO public.player_saves(player_id,state,revision) VALUES
  ('31000000-0000-4000-8000-000000000001','{"inventory":[],"ownedHeroes":[],"chests":[{"stage":1},{"stage":3,"boss":true},{"stage":2,"boss":true,"tutorial":true},{"stage":5,"boss":true},{"stage":4,"boss":true,"bound":true},{"stage":2}]}',3),
  ('31000000-0000-4000-8000-000000000002','{"inventory":[],"ownedHeroes":[],"chests":[{"stage":7}]}',3);

DO $$
DECLARE
  s uuid := '31000000-0000-4000-8000-000000000001'; b uuid := '31000000-0000-4000-8000-000000000002';
  k uuid; r jsonb; listing uuid; chests jsonb; snap jsonb;
BEGIN
  -- Only two Boss Chests are tradable (tutorial and bound ones are not).
  BEGIN
    PERFORM heroloop_api.seeker_purchase_prepare(s,gen_random_uuid(),'market_list_item',jsonb_build_object('item_id','chest:boss:3','price',50));
    RAISE EXCEPTION 'three chests quoted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'chest_not_found' THEN RAISE; END IF; END;
  BEGIN
    PERFORM heroloop_api.seeker_purchase_prepare(s,gen_random_uuid(),'market_list_item',jsonb_build_object('item_id','chest:boss:0','price',50));
    RAISE EXCEPTION 'zero chests quoted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid_chest_listing' THEN RAISE; END IF; END;

  -- List two: fee quote is two cents; the two Boss Chests leave the save, others keep order.
  k := gen_random_uuid();
  r := heroloop_api.seeker_purchase_prepare(s,k,'market_list_item',jsonb_build_object('item_id','chest:boss:2','price',50));
  IF r->>'usd_cents'<>'2' OR r#>>'{context,kind}'<>'chest_listing' THEN RAISE EXCEPTION 'list quote wrong %',r; END IF;
  r := heroloop_api.seeker_purchase_deliver(s,k);
  IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'listing refused %',r; END IF;
  listing := (r#>>'{result,listing_id}')::uuid;
  SELECT state->'chests' INTO chests FROM public.player_saves WHERE player_id=s;
  IF chests<>'[{"stage":1},{"stage":2,"boss":true,"tutorial":true},{"stage":4,"boss":true,"bound":true},{"stage":2}]'::jsonb THEN RAISE EXCEPTION 'seller chests wrong %',chests; END IF;
  IF r#>'{result,chests}'<>chests THEN RAISE EXCEPTION 'list result chests stale'; END IF;
  -- Replay neither lists twice nor takes more chests.
  PERFORM heroloop_api.seeker_purchase_deliver(s,k);
  IF (SELECT count(*) FROM public.market_chest_listings WHERE seller_id=s)<>1 THEN RAISE EXCEPTION 'list replay duplicated'; END IF;
  snap := public.market_snapshot(b);
  IF jsonb_array_length(snap->'chest_listings')<>1 OR snap#>>'{chest_listings,0,chest,quantity}'<>'2'
    OR (snap#>>'{chest_listings,0,is_own}')::boolean THEN RAISE EXCEPTION 'snapshot wrong %',snap->'chest_listings'; END IF;

  -- Cancel returns the same chests; a second cancel is refused.
  r := heroloop_api.market_cancel_listing(s,gen_random_uuid(),listing);
  IF r->>'delivered_to'<>'chests' OR jsonb_array_length(r->'chests')<>6 THEN RAISE EXCEPTION 'cancel wrong %',r; END IF;
  BEGIN
    PERFORM heroloop_api.market_cancel_listing(s,gen_random_uuid(),listing);
    RAISE EXCEPTION 'double cancel';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'market_listing_unavailable' THEN RAISE; END IF; END;

  -- List one again; the seller cannot buy it; the buyer can.
  k := gen_random_uuid();
  PERFORM heroloop_api.seeker_purchase_prepare(s,k,'market_list_item',jsonb_build_object('item_id','chest:boss:1','price',70));
  r := heroloop_api.seeker_purchase_deliver(s,k);
  listing := (r#>>'{result,listing_id}')::uuid;
  BEGIN
    PERFORM heroloop_api.seeker_purchase_prepare(s,gen_random_uuid(),'market_buy_listing',jsonb_build_object('listing_id',listing));
    RAISE EXCEPTION 'self purchase quoted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'market_self_purchase' THEN RAISE; END IF; END;
  k := gen_random_uuid();
  r := heroloop_api.seeker_purchase_prepare(b,k,'market_buy_listing',jsonb_build_object('listing_id',listing));
  IF r->>'usd_cents'<>'70' OR r#>>'{context,kind}'<>'chest' OR (r#>>'{context,seller_id}')::uuid<>s
    OR r->'context' ? 'house_seller' THEN RAISE EXCEPTION 'buy quote wrong %',r; END IF;
  r := heroloop_api.seeker_purchase_deliver(b,k);
  IF r->>'status'<>'delivered' OR r#>>'{result,delivered_to}'<>'chests' THEN RAISE EXCEPTION 'buy refused %',r; END IF;
  SELECT state->'chests' INTO chests FROM public.player_saves WHERE player_id=b;
  IF chests<>'[{"stage":7},{"stage":3,"boss":true}]'::jsonb THEN RAISE EXCEPTION 'buyer chests wrong %',chests; END IF;
  PERFORM heroloop_api.seeker_purchase_deliver(b,k);
  IF jsonb_array_length((SELECT state->'chests' FROM public.player_saves WHERE player_id=b))<>2 THEN RAISE EXCEPTION 'buy replay granted twice'; END IF;
  IF (SELECT status FROM public.market_chest_listings WHERE id=listing)<>'sold' THEN RAISE EXCEPTION 'listing not sold'; END IF;
  -- The sale shows in Activity and in both players' history.
  snap := heroloop_api.seeker_market_snapshot(b);
  IF NOT snap->'activity' @> jsonb_build_array(jsonb_build_object('id',listing,'name','Boss Chest ×1','price',70,'action','sold'))
    OR NOT snap->'history' @> jsonb_build_array(jsonb_build_object('id',listing,'action','bought')) THEN RAISE EXCEPTION 'buyer feed wrong %',snap->'history'; END IF;
  IF NOT heroloop_api.seeker_market_snapshot(s)->'history' @> jsonb_build_array(jsonb_build_object('id',listing,'action','sold')) THEN RAISE EXCEPTION 'seller history missing'; END IF;
  -- Hero sales join the same feed under the hero catalogue id.
  INSERT INTO public.market_hero_listings(seller_id,hero,price,status,buyer_id,completed_at)
    VALUES (s,'{"heroId":"fixture-hero","level":3,"stars":1}',40,'sold',b,now()+interval '1 second');
  snap := heroloop_api.seeker_market_snapshot(b);
  IF snap#>>'{activity,0,name}'<>'fixture-hero' OR snap#>>'{history,0,action}'<>'bought' THEN RAISE EXCEPTION 'hero sale missing %',snap->'activity'; END IF;

  -- A sold listing is refused at quote and, if quoted earlier, rejected (refunded) at delivery.
  k := gen_random_uuid();
  PERFORM heroloop_api.seeker_purchase_prepare(s,k,'market_list_item',jsonb_build_object('item_id','chest:boss:1','price',90));
  r := heroloop_api.seeker_purchase_deliver(s,k);
  listing := (r#>>'{result,listing_id}')::uuid;
  k := gen_random_uuid();
  PERFORM heroloop_api.seeker_purchase_prepare(b,k,'market_buy_listing',jsonb_build_object('listing_id',listing));
  PERFORM heroloop_api.market_cancel_listing(s,gen_random_uuid(),listing);
  r := heroloop_api.seeker_purchase_deliver(b,k);
  IF r->>'status'<>'rejected' OR r#>>'{result,code}'<>'market_listing_unavailable' THEN RAISE EXCEPTION 'stale buy not rejected %',r; END IF;
  -- A listing whose chests vanished after the quote is rejected, not left pending.
  UPDATE public.player_saves SET state=jsonb_set(state,'{chests}','[{"stage":8,"boss":true},{"stage":9,"boss":true}]') WHERE player_id=s;
  k := gen_random_uuid();
  PERFORM heroloop_api.seeker_purchase_prepare(s,k,'market_list_item',jsonb_build_object('item_id','chest:boss:2','price',90));
  UPDATE public.player_saves SET state=jsonb_set(state,'{chests}','[]') WHERE player_id=s;
  r := heroloop_api.seeker_purchase_deliver(s,k);
  IF r->>'status'<>'rejected' OR r#>>'{result,code}'<>'chest_not_found' THEN RAISE EXCEPTION 'missing chest list not rejected %',r; END IF;
  -- Item and hero listing quotes still route as before.
  BEGIN
    PERFORM heroloop_api.seeker_purchase_prepare(s,gen_random_uuid(),'market_list_item',jsonb_build_object('item_id',gen_random_uuid(),'price',90));
    RAISE EXCEPTION 'unknown item quoted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'item_not_found' THEN RAISE; END IF; END;
  RAISE NOTICE 'Boss Chest Market fixture PASS';
END $$;
