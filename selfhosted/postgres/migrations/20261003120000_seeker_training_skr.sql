-- Seeker Training Camp purchases in SKR: post unlocks and speed boosts.
-- Replaces the HERO spend_tokens path, which the Seeker API refuses. A delivered
-- seeker_commerce_requests row is the purchase record; legacy HERO events still count.
BEGIN;
CREATE OR REPLACE FUNCTION public.training_slot_purchase_count(p_player uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT ((SELECT count(*) FROM public.token_spend_events WHERE player_id=p_player AND action_kind='training-slot')
  +(SELECT count(*) FROM public.seeker_commerce_requests WHERE player_id=p_player AND action='training_slot_unlock' AND status='delivered'))::integer
$$;
REVOKE ALL ON FUNCTION public.training_slot_purchase_count(uuid) FROM PUBLIC,anon,authenticated;

-- Training assignment derives unlocked posts from both purchase records.
DO $$
DECLARE v_def text; v_new text;
BEGIN
 v_def:=pg_get_functiondef('public.settle_training_assignment(uuid,uuid,integer,text,bigint)'::regprocedure);
 v_new:=replace(v_def,
  E'SELECT LEAST(10, 2 + count(*))::integer INTO v_unlocked\n  FROM public.token_spend_events WHERE player_id = p_player_id AND action_kind = ''training-slot'';',
  'v_unlocked := LEAST(10, 2 + public.training_slot_purchase_count(p_player_id));');
 IF position('training_slot_purchase_count' IN v_def)>0 THEN RETURN; END IF;
 IF v_new=v_def THEN RAISE EXCEPTION 'seeker_training_slot_patch_failed'; END IF;
 EXECUTE v_new;
END $$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_purchase_prepare(p_player uuid,p_key uuid,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.seeker_commerce_requests; v_cents numeric; v_context jsonb; v_listing public.market_item_listings;
 v_store public.player_store_state; v_bundle record; v_offer jsonb; v_step jsonb; v_state jsonb; v_target jsonb; v_item public.player_items; v_previous integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('seeker-purchase:'||p_key::text,0));
 SELECT * INTO r FROM public.seeker_commerce_requests WHERE id=p_key;
 IF FOUND THEN
  IF r.player_id<>p_player OR r.action<>p_action OR r.params<>p_params THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  RETURN jsonb_build_object('context',r.context,'usd_cents',r.usd_cents);
 END IF;
 PERFORM public.assert_account_value_allowed(p_player);
 v_context:=jsonb_build_object('action',p_action,'params',p_params);
 IF p_action='market_list_item' THEN
  IF (p_params->>'price')::bigint NOT BETWEEN 1 AND 100000000 THEN RAISE EXCEPTION 'invalid_market_price'; END IF;
  PERFORM 1 FROM public.player_items WHERE id=(p_params->>'item_id')::uuid AND player_id=p_player AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  v_cents:=2;
 ELSIF p_action='market_buy_listing' THEN
  SELECT * INTO v_listing FROM public.market_item_listings WHERE id=(p_params->>'listing_id')::uuid AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id=p_player THEN RAISE EXCEPTION 'market_self_purchase'; END IF;
  IF public.account_risk_level(v_listing.seller_id) IN ('review','hold') THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  v_cents:=v_listing.price;
  v_context:=v_context||jsonb_build_object('seller_id',v_listing.seller_id);
 ELSIF p_action='store_buy_item' THEN
  SELECT * INTO v_store FROM public.player_store_state WHERE player_id=p_player;
  IF NOT FOUND OR v_store.refresh_at<>(p_params->>'refresh_at')::bigint
     OR v_store.refresh_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint THEN RAISE EXCEPTION 'store_offer_expired'; END IF;
  IF (p_params->>'slot_index')::integer NOT BETWEEN 0 AND 3 THEN RAISE EXCEPTION 'invalid_store_slot'; END IF;
  v_offer:=v_store.offers->((p_params->>'slot_index')::integer);
  IF v_offer IS NULL OR (v_offer->>'sold')::boolean THEN RAISE EXCEPTION 'store_offer_sold'; END IF;
  v_cents:=(v_offer->>'price')::numeric/1000;
 ELSIF p_action='shop_bundle_buy' THEN
  SELECT * INTO v_bundle FROM public.shop_bundle_catalog() WHERE bundle=p_params->>'bundle';
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_shop_bundle_purchase'; END IF;
  v_cents:=v_bundle.catalogue_usd_cents;
 ELSIF p_action='inventory_bag_buy' THEN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_step:=public.inventory_bag_next_step(v_state);
  IF v_step IS NULL OR (v_step->>'bag')::integer<>(p_params->>'bag')::integer OR v_step->>'kind'<>p_params->>'kind'
    THEN RAISE EXCEPTION 'bag_step_unavailable'; END IF;
  v_context:=v_context||jsonb_build_object('bag_step',v_step);
  v_cents:=(v_step->>'catalogue_usd_cents')::integer;
 ELSIF p_action='hero_ascend' THEN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  SELECT value INTO v_target FROM jsonb_array_elements(v_state->'ownedHeroes') WHERE value->>'uid'=p_params->>'target_uid';
  IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;
  v_previous:=COALESCE((v_target->>'stars')::integer,0);
  IF v_previous>=20 THEN RAISE EXCEPTION 'maximum_stars'; END IF;
  v_cents:=(CASE substring(v_target->>'heroId' FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$')
   WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3 WHEN 'epic' THEN 5 WHEN 'legendary' THEN 8
   WHEN 'mythic' THEN 12 WHEN 'cosmic' THEN 20 WHEN 'divine' THEN 30 WHEN 'celestial' THEN 45 END)*(v_previous+1);
  IF v_cents IS NULL THEN RAISE EXCEPTION 'unsupported_rarity'; END IF;
  v_context:=v_context||jsonb_build_object('previous_stars',v_previous);
 ELSIF p_action='hero_capacity_upgrade' THEN
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  v_previous:=COALESCE((v_state->>'heroCapacity')::integer,500);
  IF v_previous<500 OR v_previous>=1000 OR v_previous%100<>0 THEN RAISE EXCEPTION 'hero_capacity_exceeded'; END IF;
  IF v_previous<>(p_params->>'previous_capacity')::integer THEN RAISE EXCEPTION 'hero_capacity_quote_stale'; END IF;
  v_cents:=(v_previous-400);
  v_context:=v_context||jsonb_build_object('previous_capacity',v_previous);
 ELSIF p_action='item_upgrade' THEN
  SELECT * INTO v_item FROM public.player_items WHERE id=(p_params->>'item_uid')::uuid AND player_id=p_player AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF p_params->>'operation'='reroll' AND NOT (p_params->>'use_charm')::boolean THEN
   v_cents:=(CASE v_item.rarity WHEN 'common' THEN .5 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2
    WHEN 'epic' THEN 4 WHEN 'legendary' THEN 8 WHEN 'mythic' THEN 15 WHEN 'relic' THEN 15 WHEN 'cosmic' THEN 30
    WHEN 'divine' THEN 60 WHEN 'celestial' THEN 100 WHEN 'cursed' THEN 150 WHEN 'immortal' THEN 250 WHEN 'god' THEN 400 END)
    *least(5,greatest(1,v_item.reroll_count+1));
  ELSIF p_params->>'operation'='enchant' AND (p_params->>'use_charm')::boolean AND v_item.enchant_level BETWEEN 6 AND 19 THEN
   v_cents:=(ARRAY[10,20,40,80,160,300,600,1200,3000,8000,20000,45000,70000,100000]::numeric[])[v_item.enchant_level-5];
  ELSE RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  IF v_cents IS NULL THEN RAISE EXCEPTION 'invalid_item_upgrade'; END IF;
  v_context:=v_context||jsonb_build_object('previous_enchant',v_item.enchant_level,'previous_reroll',v_item.reroll_count);
 ELSIF p_action='reward_boost_buy' THEN
  SELECT catalogue_usd_cents INTO v_cents FROM public.reward_boost_plan(p_params->>'plan');
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_reward_boost_purchase'; END IF;
 ELSIF p_action='training_slot_unlock' THEN
  -- Same catalogue as the HERO costs at the existing $0.001 HERO quote: 50 HERO = $0.05.
  v_previous:=2+public.training_slot_purchase_count(p_player);
  IF v_previous>=10 THEN RAISE EXCEPTION 'invalid_skr_product'; END IF;
  IF v_previous<>(p_params->>'unlocked_slots')::integer THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
  v_cents:=(ARRAY[5,10,20,40,80,160,320,640]::numeric[])[v_previous-1];
  v_context:=v_context||jsonb_build_object('previous_slots',v_previous);
 ELSIF p_action='training_boost_buy' THEN
  v_cents:=CASE p_params->>'boost' WHEN '2x-1h' THEN 2.5 WHEN '2x-4h' THEN 8 WHEN '4x-1h' THEN 6 WHEN '4x-4h' THEN 20 END;
  IF v_cents IS NULL THEN RAISE EXCEPTION 'invalid_skr_product'; END IF;
 ELSE RAISE EXCEPTION 'invalid_skr_product';
 END IF;
 INSERT INTO public.seeker_commerce_requests(id,player_id,action,params,context,usd_cents)
 VALUES(p_key,p_player,p_action,p_params,v_context,v_cents);
 RETURN jsonb_build_object('context',v_context,'usd_cents',v_cents);
END $$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_purchase_deliver(p_player uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.seeker_commerce_requests; v_result jsonb; v_save public.player_saves;
 v_resource jsonb; v_bundle record; v_step jsonb; v_duration interval; v_expires timestamptz; v_code text; v_target jsonb;
 v_slots integer; v_camp jsonb; v_boost text; v_multiplier integer; v_duration_ms bigint; v_now_ms bigint;
BEGIN
 SELECT * INTO r FROM public.seeker_commerce_requests WHERE id=p_key AND player_id=p_player FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'skr_quote_not_found'; END IF;
 IF r.status<>'prepared' THEN RETURN jsonb_build_object('status',r.status,'result',r.result); END IF;
 -- A subtransaction rolls back every grant before recording a definitive refusal.
 BEGIN
  PERFORM public.assert_account_value_allowed(p_player);
  IF r.action='market_list_item' THEN
   v_result:=public.seeker_settle_market_list(p_player,p_key,(r.params->>'item_id')::uuid,(r.params->>'price')::bigint);
  ELSIF r.action='market_buy_listing' THEN
   IF public.account_risk_level((r.context->>'seller_id')::uuid) IN ('review','hold') THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
   -- The listing seller and price must still equal the server-prepared quote.
   PERFORM 1 FROM public.market_item_listings WHERE id=(r.params->>'listing_id')::uuid
    AND seller_id=(r.context->>'seller_id')::uuid AND price=r.usd_cents AND status='active' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
   v_result:=public.seeker_settle_market_buy(p_player,p_key,(r.params->>'listing_id')::uuid);
  ELSIF r.action='store_buy_item' THEN
   v_result:=public.seeker_settle_store_purchase(p_player,p_key,(r.params->>'slot_index')::integer,(r.params->>'refresh_at')::bigint);
  ELSIF r.action='shop_bundle_buy' THEN
   SELECT * INTO v_bundle FROM public.shop_bundle_catalog() WHERE bundle=r.params->>'bundle';
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
   v_resource:=public.apply_resource_entries(p_player,p_key,'shop_bundle_buy',
    encode(extensions.digest(('seeker-shop:'||p_key::text)::bytea,'sha256'),'hex'),
    jsonb_build_array(jsonb_build_object('resource_id',v_bundle.resource_id,'delta',v_bundle.quantity::text,'source_key','shop_bundle')),v_save.revision+1);
   v_save.state:=jsonb_set(v_save.state,'{summonScrolls}',v_resource#>'{balances,summon_scroll}',true);
   v_save.state:=jsonb_set(v_save.state,'{bossKeys}',v_resource#>'{balances,boss_key}',true);
   v_save.state:=jsonb_set(v_save.state,'{potions}',COALESCE(v_save.state->'potions','{}'::jsonb)||jsonb_build_object(
    'xs',(v_resource#>>'{balances,potion_xs}')::bigint,'sm',(v_resource#>>'{balances,potion_sm}')::bigint,
    'md',(v_resource#>>'{balances,potion_md}')::bigint,'lg',(v_resource#>>'{balances,potion_lg}')::bigint,
    'xl',(v_resource#>>'{balances,potion_xl}')::bigint,'xxl',(v_resource#>>'{balances,potion_xxl}')::bigint),true);
   UPDATE public.players SET boss_keys=(v_resource#>>'{balances,boss_key}')::integer WHERE player_id=p_player;
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('state',v_save.state,'revision',v_save.revision,'bundle',r.params->>'bundle');
  ELSIF r.action='inventory_bag_buy' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
   v_step:=public.inventory_bag_next_step(v_save.state);
   IF v_step IS DISTINCT FROM r.context->'bag_step' THEN RAISE EXCEPTION 'bag_step_unavailable'; END IF;
   v_save.state:=jsonb_set(v_save.state,'{bagSlots}',jsonb_set(COALESCE(v_save.state->'bagSlots','[64,0,0,0]'::jsonb),
     ARRAY[((v_step->>'bag')::integer-1)::text],v_step->'slots'),true);
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('bag_slots',v_save.state->'bagSlots','revision',v_save.revision);
  ELSIF r.action='hero_ascend' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   SELECT value INTO v_target FROM jsonb_array_elements(v_save.state->'ownedHeroes') WHERE value->>'uid'=r.params->>'target_uid';
   IF v_target IS NULL THEN RAISE EXCEPTION 'target_not_found'; END IF;
   IF COALESCE((v_target->>'stars')::integer,0)<>(r.context->>'previous_stars')::integer THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
   v_result:=public.seeker_settle_hero_ascension(p_player,p_key,r.params->>'target_uid',false);
  ELSIF r.action='hero_capacity_upgrade' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF COALESCE((v_save.state->>'heroCapacity')::integer,500)<>(r.context->>'previous_capacity')::integer THEN RAISE EXCEPTION 'hero_capacity_quote_stale'; END IF;
   v_save.state:=jsonb_set(v_save.state,'{heroCapacity}',to_jsonb((r.context->>'previous_capacity')::integer+100),true);
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('hero_capacity',v_save.state->'heroCapacity','revision',v_save.revision);
  ELSIF r.action='item_upgrade' THEN
   PERFORM 1 FROM public.player_items WHERE id=(r.params->>'item_uid')::uuid AND player_id=p_player AND removed_at IS NULL
     AND enchant_level=(r.context->>'previous_enchant')::integer AND reroll_count=(r.context->>'previous_reroll')::integer FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
   v_result:=public.seeker_settle_item_upgrade(p_player,p_key,r.params->>'operation',(r.params->>'item_uid')::uuid,(r.params->>'use_charm')::boolean);
  ELSIF r.action='reward_boost_buy' THEN
   SELECT duration INTO v_duration FROM public.reward_boost_plan(r.params->>'plan');
   PERFORM 1 FROM public.players WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
   INSERT INTO public.player_account_bonuses(player_id,source_key,granted_at,expires_at,grant_reason)
   VALUES(p_player,'reward_boost',now(),now()+v_duration,'purchase:skr-reward-boost')
   ON CONFLICT(player_id,source_key) DO UPDATE SET revoked_at=NULL,
    expires_at=CASE WHEN player_account_bonuses.revoked_at IS NULL AND player_account_bonuses.expires_at>now()
       THEN player_account_bonuses.expires_at ELSE now() END+v_duration,
    grant_reason='purchase:skr-reward-boost' RETURNING expires_at INTO v_expires;
   v_result:=jsonb_build_object('boost_expires_at',v_expires,'bonus',public.account_reward_bonus(p_player));
  ELSIF r.action IN ('training_slot_unlock','training_boost_buy') THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
   v_slots:=LEAST(10,2+public.training_slot_purchase_count(p_player));
   IF r.action='training_slot_unlock' THEN
    IF v_slots<>(r.context->>'previous_slots')::integer OR v_slots>=10 THEN RAISE EXCEPTION 'skr_product_changed'; END IF;
    v_slots:=v_slots+1;
   END IF;
   -- Settle earned training time first so a new boost never applies retroactively.
   v_save.state:=public.settle_training_state_at(v_save.state,clock_timestamp(),v_slots);
   v_camp:=v_save.state->'trainingCamp';
   IF r.action='training_boost_buy' THEN
    v_boost:=r.params->>'boost';
    v_multiplier:=left(v_boost,1)::integer;
    v_duration_ms:=substring(v_boost FROM '-(\d)h$')::bigint*3600000;
    v_now_ms:=(v_camp->>'lastTick')::bigint;
    IF COALESCE((v_camp->>'boostMultiplier')::integer,1)<=1 OR COALESCE((v_camp->>'boostEndsAt')::bigint,0)<=v_now_ms THEN
     v_camp:=v_camp||jsonb_build_object('activeBoostKey',v_boost,'boostMultiplier',v_multiplier,'boostEndsAt',v_now_ms+v_duration_ms);
    ELSIF v_camp->>'activeBoostKey'=v_boost THEN
     v_camp:=jsonb_set(v_camp,'{boostEndsAt}',to_jsonb((v_camp->>'boostEndsAt')::bigint+v_duration_ms),true);
    ELSE
     v_camp:=jsonb_set(v_camp,'{boostQueue}',COALESCE(v_camp->'boostQueue','[]'::jsonb)
      ||jsonb_build_array(jsonb_build_object('key',v_boost,'multiplier',v_multiplier,'durationMs',v_duration_ms)),true);
    END IF;
    v_save.state:=jsonb_set(v_save.state,'{trainingCamp}',v_camp,true);
   END IF;
   UPDATE public.player_saves SET state=v_save.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING revision INTO v_save.revision;
   v_result:=jsonb_build_object('training_camp',v_camp,'owned_heroes',v_save.state->'ownedHeroes','revision',v_save.revision);
  END IF;
 EXCEPTION WHEN raise_exception THEN
  GET STACKED DIAGNOSTICS v_code=MESSAGE_TEXT;
  IF v_code NOT IN ('market_listing_unavailable','market_self_purchase','market_seller_limit_reached',
   'market_test_item_required','item_not_found','item_locked','item_equipped','item_state_mismatch','save_not_found',
   'skr_product_changed','target_not_found','maximum_stars','insufficient_duplicates','unsupported_rarity','invalid_save_state','hero_capacity_quote_stale','maximum_enchant','insufficient_gold','invalid_item_upgrade','account_not_found','account_restricted','bag_step_unavailable','idempotency_conflict','player_not_found','store_offer_expired','store_offer_sold','invalid_store_slot','resource_balance_cap') THEN RAISE; END IF;
  UPDATE public.seeker_commerce_requests SET status='rejected',result=jsonb_build_object('code',v_code) WHERE id=p_key;
  RETURN jsonb_build_object('status','rejected','result',jsonb_build_object('code',v_code));
 END;
 UPDATE public.seeker_commerce_requests SET status='delivered',result=v_result WHERE id=p_key;
 RETURN jsonb_build_object('status','delivered','result',v_result);
END $$;

REVOKE ALL ON FUNCTION heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb),heroloop_api.seeker_purchase_deliver(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb),heroloop_api.seeker_purchase_deliver(uuid,uuid) TO heroloop_api;
COMMIT;
