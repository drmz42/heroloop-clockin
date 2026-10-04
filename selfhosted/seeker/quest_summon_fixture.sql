-- Disposable accounts only. No chain, real wallet or live payment is used.
\set ON_ERROR_STOP 1
DO $$
DECLARE p uuid; k uuid; r jsonb; s public.player_saves; balance numeric; focus jsonb; before_count integer; total numeric; scroll_balance bigint;
BEGIN
 SELECT player_id INTO p FROM public.player_saves WHERE public.account_risk_level(player_id) NOT IN ('review','hold') ORDER BY player_id LIMIT 1;
 SELECT token_balance,ascension_focus INTO balance,focus FROM public.players WHERE player_id=p;
 -- An archived selection stays saved and cannot influence either Summon path.
 UPDATE public.players SET ascension_focus='{"common":"knight-common"}' WHERE player_id=p;
 -- Scroll settlement and exact replay share the same atomic award/debit path.
 PERFORM public.apply_resource_entries(p,gen_random_uuid(),'scroll_fixture',repeat('a',64),
  '[{"resource_id":"summon_scroll","delta":"111","source_key":"promo_summon_scroll"}]',NULL);
 scroll_balance:=(public.resource_snapshot(p)#>>'{balances,summon_scroll}')::bigint;
 FOR before_count IN SELECT unnest(ARRAY[1,10,100]) LOOP
  SELECT * INTO s FROM public.player_saves WHERE player_id=p;
  k:=gen_random_uuid();
  BEGIN
   PERFORM heroloop_api.seeker_scroll_summon(p,k,before_count,s.revision,'scroll',NULL);
   RAISE EXCEPTION USING ERRCODE='57014', MESSAGE='fixture statement timeout';
  EXCEPTION WHEN query_canceled THEN NULL;
  END;
  IF (public.resource_snapshot(p)#>>'{balances,summon_scroll}')::bigint<>scroll_balance
   OR (SELECT revision FROM public.player_saves WHERE player_id=p)<>s.revision
   OR EXISTS(SELECT 1 FROM public.summon_events WHERE idempotency_key=k) THEN
   RAISE EXCEPTION 'Cancelled Scroll transaction retained debit or award';
  END IF;
  r:=heroloop_api.seeker_scroll_summon(p,k,before_count,s.revision,'scroll',NULL);
  scroll_balance:=scroll_balance-before_count;
  IF jsonb_array_length(r->'heroes')<>before_count OR (r->>'scrolls_spent')::integer<>before_count
   OR (r->>'summon_scrolls')::bigint<>scroll_balance OR (r->>'spent')::numeric<>0 THEN
   RAISE EXCEPTION 'Scroll settlement mismatch';
  END IF;
  IF heroloop_api.seeker_scroll_summon(p,k,before_count,s.revision,'scroll',NULL)<>r
   OR (public.resource_snapshot(p)#>>'{balances,summon_scroll}')::bigint<>scroll_balance THEN
   RAISE EXCEPTION 'Scroll replay changed award or debit';
  END IF;
 END LOOP;
 FOR before_count IN SELECT unnest(ARRAY[1,10,100]) LOOP
  k:=gen_random_uuid();
  r:=heroloop_api.seeker_purchase_prepare(p,k,'hero_summon',jsonb_build_object('count',before_count));
  IF (r->>'usd_cents')::numeric<>2*before_count THEN RAISE EXCEPTION 'SKR summon price'; END IF;
  r:=heroloop_api.seeker_purchase_deliver(p,k);
  IF r->>'status'<>'delivered' OR jsonb_array_length(r#>'{result,heroes}')<>before_count THEN RAISE EXCEPTION 'SKR summon grant %',r; END IF;
  IF r#>'{result,focus_locked}'<>'{}'::jsonb OR (r#>>'{result,scrolls_spent}')::integer<>0 OR (r#>>'{result,spent}')::numeric<>0 THEN RAISE EXCEPTION 'SKR summon spent legacy currency or applied Focus'; END IF;
  IF heroloop_api.seeker_purchase_deliver(p,k)<>r THEN RAISE EXCEPTION 'Summon replay changed'; END IF;
  PERFORM heroloop_api.seeker_purchase_record_payment(p,k,100000000);
  PERFORM heroloop_api.seeker_purchase_record_payment(p,k,100000000);
 END LOOP;
 IF (SELECT ascension_focus FROM public.players WHERE player_id=p)<>'{"common":"knight-common"}'::jsonb THEN RAISE EXCEPTION 'archived Focus lost'; END IF;
 IF (SELECT token_balance FROM public.players WHERE player_id=p)<>balance THEN RAISE EXCEPTION 'HERO was spent'; END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 before_count:=jsonb_array_length(s.state->'ownedHeroes');
 -- Capacity changed after quoting: durable rejection, no grant/payment counter.
 k:=gen_random_uuid();
 PERFORM heroloop_api.seeker_purchase_prepare(p,k,'hero_summon','{"count":100}');
 UPDATE public.player_saves SET state=jsonb_set(state,'{heroCapacity}',to_jsonb(before_count),true) WHERE player_id=p;
 r:=heroloop_api.seeker_purchase_deliver(p,k);
 IF r->>'status'<>'rejected' OR r#>>'{result,code}'<>'hero_capacity_exceeded' THEN RAISE EXCEPTION 'capacity rejection %',r; END IF;
 BEGIN PERFORM heroloop_api.seeker_purchase_record_payment(p,k,100000000); RAISE EXCEPTION 'bad payment accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'invalid_skr_payment_receipt' THEN RAISE; END IF; END;
 UPDATE public.player_saves SET state=jsonb_set(state,'{heroCapacity}','1000',true) WHERE player_id=p;
 -- Normal Daily rewards cannot emit tokens, even with a forged token reward.
 UPDATE public.player_saves SET state=state||jsonb_build_object('lastQuestReset',floor(extract(epoch FROM now())*1000)::bigint,
  'dailyQuests',public.quest_advance_prefix(public.quest_daily_catalogue(),'kill-',10000)) WHERE player_id=p;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 r:=heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'kill-1000',s.revision);
 IF (r#>>'{reward,hero}')::numeric<>0 OR (SELECT token_balance FROM public.players WHERE player_id=p)<>balance THEN RAISE EXCEPTION 'quest emitted token'; END IF;
 -- Server receipts only; client progress cannot make an activity quest ready.
 SELECT value INTO r FROM jsonb_array_elements(heroloop_api.seeker_quest_status(p)->'quests') WHERE value->>'id'='skr-daily-100';
 IF (r->>'progress')::numeric<>300 THEN RAISE EXCEPTION 'SKR replay counter %',r; END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 k:=gen_random_uuid(); r:=heroloop_api.seeker_quest_claim(p,k,'skr-daily-100',s.revision);
 IF NOT (r->>'claimed')::boolean OR (r#>>'{reward,gold}')::bigint<>500 THEN RAISE EXCEPTION 'daily claim failed'; END IF;
 IF NOT (heroloop_api.seeker_quest_claim(p,k,'skr-daily-100',s.revision)->>'replayed')::boolean THEN RAISE EXCEPTION 'claim replay'; END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 BEGIN PERFORM heroloop_api.seeker_quest_claim(p,gen_random_uuid(),'skr-daily-100',s.revision); RAISE EXCEPTION 'double claim';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'quest_already_claimed' THEN RAISE; END IF; END;
 -- Cross-day payments count for lifetime, never for today's spend.
 UPDATE public.seeker_commerce_requests SET paid_at=now()-interval '2 days' WHERE player_id=p AND payment_minor IS NOT NULL;
 SELECT value INTO r FROM jsonb_array_elements(heroloop_api.seeker_quest_status(p)->'quests') WHERE value->>'id'='skr-daily-100';
 IF (r->>'progress')::numeric<>0 THEN RAISE EXCEPTION 'day reset failed'; END IF;
 UPDATE public.seeker_commerce_requests SET payment_minor=10000000000000 WHERE player_id=p AND action='hero_summon' AND status='delivered';
 SELECT * INTO s FROM public.player_saves WHERE player_id=p;
 k:=gen_random_uuid(); r:=heroloop_api.seeker_quest_claim(p,k,'skr-lifetime-10000000',s.revision);
 IF (r#>>'{reward,summonScrolls}')::integer<>50 THEN RAISE EXCEPTION '10M reward'; END IF;
 IF (SELECT token_balance FROM public.players WHERE player_id=p)<>balance THEN RAISE EXCEPTION 'activity quest emitted tokens'; END IF;
 IF has_function_privilege('heroloop_api_runtime','public.seeker_settle_hero_summon(uuid,uuid,integer,bigint,text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'direct unpaid SKR grant exposed'; END IF;
 UPDATE public.players SET ascension_focus=focus WHERE player_id=p;
END $$;
