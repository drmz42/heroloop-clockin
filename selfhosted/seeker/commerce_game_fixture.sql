-- Disposable game DB only, called by the API contract fixture before teardown.
\set ON_ERROR_STOP 1
DO $$
DECLARE v_players uuid[]; p uuid; q uuid; z uuid; item uuid:=gen_random_uuid(); listing uuid;
 k uuid:=gen_random_uuid(); request uuid:=gen_random_uuid(); r jsonb; v_state jsonb; balances jsonb; after_balances jsonb;
BEGIN
 SELECT array_agg(player_id) INTO v_players FROM (SELECT player_id FROM public.player_saves WHERE public.account_risk_level(player_id) NOT IN ('review','hold') ORDER BY player_id LIMIT 3) t;
 IF array_length(v_players,1)<>3 THEN RAISE EXCEPTION 'requires three disposable game accounts'; END IF;
 p:=v_players[1];q:=v_players[2];z:=v_players[3];
 SELECT jsonb_object_agg(player_id,token_balance) INTO balances FROM public.players WHERE player_id=ANY(v_players);
 INSERT INTO public.player_items(id,player_id,base_item_id,slot,rarity,item_level,stats,power,locked,reroll_count,enchant_stats_version,source_kind)
 VALUES(item,p,'weapon-warrior-legendary','class_weapon','legendary',1,'[]',100,false,0,2,'store');
 SELECT player_saves.state INTO v_state FROM public.player_saves WHERE player_id=p;
 UPDATE public.player_saves SET state=jsonb_set(player_saves.state,'{inventory}',jsonb_build_array(jsonb_build_object('uid',item,'itemId','weapon-warrior-legendary','serverOwned',true)),true) WHERE player_id=p;
 r:=heroloop_api.seeker_purchase_prepare(p,k,'market_list_item',jsonb_build_object('item_id',item,'price',100));
 IF r->>'usd_cents'<>'2' THEN RAISE EXCEPTION 'listing fee not two cents'; END IF;
 r:=heroloop_api.seeker_purchase_deliver(p,k);
 IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'listing refused %',r; END IF;
 listing:=(r#>>'{result,listing,id}')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.player_items WHERE id=item AND player_id=p) THEN RAISE EXCEPTION 'escrow ownership changed'; END IF;
 PERFORM heroloop_api.seeker_purchase_deliver(p,k);
 IF (SELECT count(*) FROM public.market_item_listings WHERE item_id=item)<>1 THEN RAISE EXCEPTION 'listing replay duplicated'; END IF;
 PERFORM heroloop_api.seeker_purchase_prepare(q,'72000000-0000-4000-8000-000000000001','market_buy_listing',jsonb_build_object('listing_id',listing));
 PERFORM heroloop_api.seeker_purchase_prepare(z,'72000000-0000-4000-8000-000000000002','market_buy_listing',jsonb_build_object('listing_id',listing));
 -- Store grant/replay uses SKR, never Gold or legacy token balance.
 r:=public.store_snapshot(p);
 PERFORM heroloop_api.seeker_purchase_prepare(p,request,'store_buy_item',jsonb_build_object('slot_index',0,'refresh_at',r->'refresh_at'));
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'store grant refused %',r; END IF;
 IF r#>>'{result,item,itemRollVersion}'<>'5' THEN RAISE EXCEPTION 'store changed V5 item rolls'; END IF;
 IF (SELECT (player_saves.state->>'gold')::numeric FROM public.player_saves WHERE player_id=p)<>(v_state->>'gold')::numeric THEN RAISE EXCEPTION 'store spent Gold'; END IF;
 PERFORM heroloop_api.seeker_purchase_deliver(p,request);
 IF (SELECT count(*) FROM public.store_purchase_events WHERE idempotency_key=request)<>1 THEN RAISE EXCEPTION 'store grant twice'; END IF;
 request:=gen_random_uuid();
 PERFORM heroloop_api.seeker_purchase_prepare(p,request,'shop_bundle_buy','{"bundle":"scroll_1"}');
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'bundle refused %',r; END IF;
 v_state:=r#>'{result,state}';
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r#>'{result,state,summonScrolls}'<>v_state->'summonScrolls' THEN RAISE EXCEPTION 'bundle replay grant'; END IF;
 request:=gen_random_uuid();
 PERFORM heroloop_api.seeker_purchase_prepare(p,request,'reward_boost_buy','{"plan":"24h"}');
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'boost refused %',r; END IF;
 v_state:=r;
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r<>v_state THEN RAISE EXCEPTION 'boost replay extended time'; END IF;
 request:=gen_random_uuid();
 r:=heroloop_api.seeker_bag_snapshot(p);
 IF COALESCE((r->>'complete')::boolean,false) IS FALSE THEN
  PERFORM heroloop_api.seeker_purchase_prepare(p,request,'inventory_bag_buy',jsonb_build_object('bag',r->'bag','kind',r->'kind'));
  r:=heroloop_api.seeker_purchase_deliver(p,request);
  IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'bag refused %',r; END IF;
  v_state:=r;
  IF heroloop_api.seeker_purchase_deliver(p,request)<>v_state THEN RAISE EXCEPTION 'bag replay'; END IF;
 END IF;
 -- Paid development uses the same SKR saga; legacy balances remain untouched.
 UPDATE public.player_saves SET state=state||jsonb_build_object('ownedHeroes',
  (SELECT jsonb_agg(jsonb_build_object('uid','skr-hero-'||n,'heroId','knight-common','stars',0,'locked',false,'equipment','{}'::jsonb)) FROM generate_series(1,30) n),
  'gold',100000000,'team','[]'::jsonb,'trainingCamp',jsonb_build_object('heroUids','[]'::jsonb),'heroCapacity',500) WHERE player_id=p;
 request:=gen_random_uuid();
 r:=heroloop_api.seeker_purchase_prepare(p,request,'hero_ascend','{"target_uid":"skr-hero-1"}');
 IF r->>'usd_cents'<>'1' THEN RAISE EXCEPTION 'ascension catalog'; END IF;
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' OR r#>>'{result,target_stars}'<>'1' THEN RAISE EXCEPTION 'ascension refused %',r; END IF;
 IF heroloop_api.seeker_purchase_deliver(p,request)<>r THEN RAISE EXCEPTION 'ascension replay'; END IF;
 request:=gen_random_uuid();
 PERFORM heroloop_api.seeker_purchase_prepare(p,request,'hero_capacity_upgrade','{"previous_capacity":500}');
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r#>>'{result,hero_capacity}'<>'600' OR heroloop_api.seeker_purchase_deliver(p,request)<>r THEN RAISE EXCEPTION 'capacity replay %',r; END IF;
 -- Training posts and speed boosts settle server-side from the SKR receipt.
 request:=gen_random_uuid();
 r:=heroloop_api.seeker_purchase_prepare(p,request,'training_slot_unlock',jsonb_build_object('unlocked_slots',2+public.training_slot_purchase_count(p)));
 IF (r->>'usd_cents')::numeric<>5 THEN RAISE EXCEPTION 'training slot catalog %',r; END IF;
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' OR r#>>'{result,training_camp,unlockedSlots}'<>'3' THEN RAISE EXCEPTION 'training slot refused %',r; END IF;
 IF heroloop_api.seeker_purchase_deliver(p,request)<>r OR public.training_slot_purchase_count(p)<>1 THEN RAISE EXCEPTION 'training slot replay'; END IF;
 BEGIN
  PERFORM heroloop_api.seeker_purchase_prepare(p,gen_random_uuid(),'training_slot_unlock','{"unlocked_slots":2}');
  RAISE EXCEPTION 'stale training slot quoted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'skr_product_changed' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM heroloop_api.seeker_purchase_prepare(p,gen_random_uuid(),'training_boost_buy','{"boost":"9x-1h"}');
  RAISE EXCEPTION 'unknown training boost quoted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'invalid_skr_product' THEN RAISE; END IF;
 END;
 request:=gen_random_uuid();
 r:=heroloop_api.seeker_purchase_prepare(p,request,'training_boost_buy','{"boost":"2x-1h"}');
 IF (r->>'usd_cents')::numeric<>2.5 THEN RAISE EXCEPTION 'training boost catalog %',r; END IF;
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' OR r#>>'{result,training_camp,boostMultiplier}'<>'2' OR r#>>'{result,training_camp,activeBoostKey}'<>'2x-1h'
  OR r#>>'{result,training_camp,unlockedSlots}'<>'3' THEN RAISE EXCEPTION 'training boost refused %',r; END IF;
 IF heroloop_api.seeker_purchase_deliver(p,request)<>r THEN RAISE EXCEPTION 'training boost replay'; END IF;
 item:=gen_random_uuid();
 INSERT INTO public.player_items(id,player_id,base_item_id,slot,rarity,item_level,stats,power,enchant_level,locked,reroll_count,enchant_stats_version,item_roll_version,source_kind)
 VALUES(item,p,'weapon-warrior-common','class_weapon','common',1,'[]',100,6,false,0,4,5,'store');
 UPDATE public.player_saves SET state=jsonb_set(state,'{inventory}',COALESCE(state->'inventory','[]'::jsonb)||jsonb_build_array(jsonb_build_object('uid',item,'itemId','weapon-warrior-common','serverOwned',true)),true) WHERE player_id=p;
 request:=gen_random_uuid();
 r:=heroloop_api.seeker_purchase_prepare(p,request,'item_upgrade',jsonb_build_object('operation','reroll','item_uid',item,'use_charm',false));
 IF (r->>'usd_cents')::numeric<>.5 THEN RAISE EXCEPTION 'half-cent catalog'; END IF;
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' OR r#>>'{result,item,itemRollVersion}'<>'5' THEN RAISE EXCEPTION 'reroll refused %',r; END IF;
 IF heroloop_api.seeker_purchase_deliver(p,request)<>r THEN RAISE EXCEPTION 'reroll replay'; END IF;
 request:=gen_random_uuid();
 PERFORM heroloop_api.seeker_purchase_prepare(p,request,'item_upgrade',jsonb_build_object('operation','enchant','item_uid',item,'use_charm',true));
 r:=heroloop_api.seeker_purchase_deliver(p,request);
 IF r->>'status'<>'delivered' OR r#>>'{result,item,enchantLevel}'<>'7' THEN RAISE EXCEPTION 'charm refused %',r; END IF;
 IF heroloop_api.seeker_purchase_deliver(p,request)<>r THEN RAISE EXCEPTION 'charm replay'; END IF;
 SELECT jsonb_object_agg(player_id,token_balance) INTO after_balances FROM public.players WHERE player_id=ANY(v_players);
 IF after_balances<>balances THEN RAISE EXCEPTION 'commerce changed HERO balances'; END IF;
END $$;
