-- Seeker-only adapters; standard settlement and saved Focus selections remain intact.
BEGIN;
ALTER TABLE public.seeker_commerce_requests ADD COLUMN IF NOT EXISTS payment_minor numeric(30,0) CHECK(payment_minor>0);
ALTER TABLE public.seeker_commerce_requests ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE public.summon_events DROP CONSTRAINT IF EXISTS summon_events_payment_method_check;
ALTER TABLE public.summon_events ADD CONSTRAINT summon_events_payment_method_check CHECK(payment_method IN ('legacy_paid','paid','scroll','skr'));

-- Reuse the current rarity/Pity/capacity engine without spending HERO or Scrolls.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('public.settle_hero_summon(uuid,uuid,integer,bigint,text,uuid)'::regprocedure);
 d:=replace(d,'public.settle_hero_summon(', 'public.seeker_settle_hero_summon(');
 d:=replace(d,$s$p_payment_method NOT IN ('paid', 'scroll')$s$, $s$p_payment_method NOT IN ('skr', 'scroll')$s$);
 d:=replace(d,'v_scroll_cost := p_count;',$s$v_scroll_cost := CASE WHEN p_payment_method='scroll' THEN p_count ELSE 0 END;$s$);
 d:=replace(d,$s$v_focus := COALESCE(v_focus, '{}'::jsonb);$s$, $s$v_focus := '{}'::jsonb; -- archived: identity Focus is inactive$s$);
 d:=replace(d,'ascension_focus = v_focus,','ascension_focus = ascension_focus,');
 IF position('public.seeker_settle_hero_summon(' IN d)=0 OR position($s$v_focus := '{}'::jsonb;$s$ IN d)=0 THEN RAISE EXCEPTION 'seeker_summon_patch_failed'; END IF;
 EXECUTE d;
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_hero_summon(uuid,uuid,integer,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_scroll_summon(p_player uuid,p_key uuid,p_count integer,p_revision bigint,p_method text,p_quote uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_method<>'scroll' OR p_method IS NULL OR p_quote IS NOT NULL THEN RAISE EXCEPTION 'invalid_summon'; END IF;
 PERFORM public.assert_account_value_allowed(p_player);
 RETURN public.seeker_settle_hero_summon(p_player,p_key,p_count,p_revision,p_method,p_quote);
END $$;
REVOKE ALL ON FUNCTION heroloop_api.seeker_scroll_summon(uuid,uuid,integer,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_scroll_summon(uuid,uuid,integer,bigint,text,uuid) TO heroloop_api;

-- Extend the existing server-owned quote and durable delivery saga.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
 IF position($s$p_action='hero_summon'$s$ IN d)=0 THEN
 d:=replace(d,$s$IF p_action='market_list_item' THEN$s$,$patch$IF p_action='hero_summon' THEN
  IF (p_params->>'count')::integer NOT IN (1,10,100) THEN RAISE EXCEPTION 'invalid_summon'; END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
  IF v_state IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF jsonb_array_length(v_state->'ownedHeroes')+(p_params->>'count')::integer>COALESCE((v_state->>'heroCapacity')::integer,500) THEN RAISE EXCEPTION 'hero_capacity_exceeded'; END IF;
  v_cents:=2*(p_params->>'count')::integer;
 ELSIF p_action='market_list_item' THEN$patch$);
 IF position($s$p_action='hero_summon'$s$ IN d)=0 THEN RAISE EXCEPTION 'seeker_summon_prepare_patch_failed'; END IF;
 EXECUTE d; END IF;
 d:=pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
 IF position($s$r.action='hero_summon'$s$ IN d)=0 THEN
 d:=replace(d,$s$IF r.action='market_list_item' THEN$s$,$patch$IF r.action='hero_summon' THEN
   SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
   v_result:=public.seeker_settle_hero_summon(p_player,p_key,(r.params->>'count')::integer,v_save.revision,'skr',NULL);
  ELSIF r.action='market_list_item' THEN$patch$);
 d:=replace(d,$s$'market_listing_unavailable','market_self_purchase'$s$, $s$'hero_capacity_exceeded','invalid_owned_heroes','invalid_summon','market_listing_unavailable','market_self_purchase'$s$);
 IF position($s$r.action='hero_summon'$s$ IN d)=0 THEN RAISE EXCEPTION 'seeker_summon_deliver_patch_failed'; END IF;
 EXECUTE d; END IF;
END $$;

-- Only the private-wallet adapter calls this after a committed payment. Client
-- prices/balances, deposits, withdrawals and refunded purchases never count.
CREATE OR REPLACE FUNCTION heroloop_api.seeker_purchase_record_payment(p_player uuid,p_key uuid,p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.seeker_commerce_requests; BEGIN
 SELECT * INTO r FROM public.seeker_commerce_requests WHERE id=p_key AND player_id=p_player FOR UPDATE;
 IF NOT FOUND OR r.status<>'delivered' OR p_amount IS NULL OR p_amount<=0 OR p_amount<>trunc(p_amount) THEN RAISE EXCEPTION 'invalid_skr_payment_receipt'; END IF;
 IF r.payment_minor IS NOT NULL AND r.payment_minor<>p_amount THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
 UPDATE public.seeker_commerce_requests SET payment_minor=p_amount,paid_at=COALESCE(paid_at,clock_timestamp()) WHERE id=p_key;
 RETURN jsonb_build_object('recorded',true);
END $$;

CREATE OR REPLACE FUNCTION public.seeker_activity_quest_catalogue()
RETURNS TABLE(id text,kind text,label text,target bigint,gold bigint,scrolls bigint)
LANGUAGE sql IMMUTABLE AS $$
 VALUES
 ('skr-daily-100','daily','Spend 100 SKR',100,500,0),
 ('skr-daily-1000','daily','Spend 1,000 SKR',1000,1500,1),
 ('skr-daily-10000','daily','Spend 10,000 SKR',10000,5000,2),
 ('skr-buy-1','daily','Buy 1 equipment item',1,500,0),
 ('skr-list-1','daily','List 1 equipment item on Market',1,500,0),
 ('skr-lifetime-1000','milestone','Spend 1,000 SKR total',1000,2500,1),
 ('skr-lifetime-10000','milestone','Spend 10,000 SKR total',10000,5000,3),
 ('skr-lifetime-100000','milestone','Spend 100,000 SKR total',100000,10000,5),
 ('skr-lifetime-1000000','milestone','Spend 1,000,000 SKR total',1000000,25000,10),
 ('skr-lifetime-10000000','milestone','Spend 10,000,000 SKR total',10000000,100000,50)
$$;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_quest_status(p_player uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH counters AS (
  SELECT COALESCE(sum(payment_minor),0)/1000000 AS lifetime,
   COALESCE(sum(payment_minor) FILTER(WHERE (paid_at AT TIME ZONE 'Europe/Moscow')::date=(now() AT TIME ZONE 'Europe/Moscow')::date),0)/1000000 AS daily,
   count(*) FILTER(WHERE action IN ('market_buy_listing','store_buy_item') AND (paid_at AT TIME ZONE 'Europe/Moscow')::date=(now() AT TIME ZONE 'Europe/Moscow')::date) AS bought,
   count(*) FILTER(WHERE action='market_list_item' AND (paid_at AT TIME ZONE 'Europe/Moscow')::date=(now() AT TIME ZONE 'Europe/Moscow')::date) AS listed
  FROM public.seeker_commerce_requests WHERE player_id=p_player AND status='delivered' AND payment_minor IS NOT NULL
 ) SELECT jsonb_build_object('quests',COALESCE(jsonb_agg(jsonb_build_object(
  'id',q.id,'kind',q.kind,'label',q.label,'target',q.target,
  'progress',floor(CASE WHEN q.id='skr-buy-1' THEN c.bought WHEN q.id='skr-list-1' THEN c.listed WHEN q.kind='daily' THEN c.daily ELSE c.lifetime END),
  'reward',jsonb_build_object('gold',q.gold,'hero',0,'summonScrolls',q.scrolls),
  'claimed',EXISTS(SELECT 1 FROM public.quest_claim_events e WHERE e.player_id=p_player AND e.instance_key=
   CASE WHEN q.kind='daily' THEN 'daily:'||q.id||':'||to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') ELSE q.id END)
 ) ORDER BY q.target,q.id),'[]'::jsonb),'ore_available',false)
 FROM public.seeker_activity_quest_catalogue() q CROSS JOIN counters c
$$;

-- Existing Daily/Milestone rewards retain Gold/Scrolls, with zero token issuance.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('public.settle_quest_claim_before_compact_receipt(uuid,uuid,text,bigint)'::regprocedure);
 d:=replace(d,'public.settle_quest_claim_before_compact_receipt(', 'public.seeker_quest_claim_before_compact_receipt(');
 d:=replace(d,$s$IF p_quest_id LIKE 'milestone-%' THEN$s$, $s$IF p_quest_id LIKE 'milestone-token-%' THEN RAISE EXCEPTION 'quest_unknown'; END IF; IF p_quest_id LIKE 'milestone-%' THEN$s$);
 d:=replace(d,$s$IF EXISTS (SELECT 1 FROM public.quest_claim_events WHERE player_id=p_player_id AND instance_key=v_instance)$s$, $s$v_hero:=0; v_reward:=jsonb_set(v_reward,'{hero}','0'::jsonb,true); IF EXISTS (SELECT 1 FROM public.quest_claim_events WHERE player_id=p_player_id AND instance_key=v_instance)$s$);
 IF position('v_hero:=0;' IN d)=0 THEN RAISE EXCEPTION 'seeker_quest_patch_failed'; END IF;
 EXECUTE d;
 d:=pg_get_functiondef('public.settle_quest_claim(uuid,uuid,text,bigint)'::regprocedure);
 d:=replace(d,'public.settle_quest_claim(', 'public.seeker_settle_quest_claim(');
 d:=replace(d,'public.settle_quest_claim_before_compact_receipt(', 'public.seeker_quest_claim_before_compact_receipt(');
 EXECUTE d;
END $$;

DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('heroloop_api.partner_quest_claim(uuid,uuid,bigint,bigint)'::regprocedure);
 d:=replace(d,'heroloop_api.partner_quest_claim(', 'heroloop_api.seeker_partner_quest_claim(');
 d:=replace(d,'v_reward := v_quest.reward;', $s$v_reward := jsonb_set(v_quest.reward,'{hero}','0'::jsonb,true);$s$);
 IF position($s$jsonb_set(v_quest.reward$s$ IN d)=0 THEN RAISE EXCEPTION 'seeker_partner_reward_patch_failed'; END IF;
 EXECUTE d;
END $$;
REVOKE ALL ON FUNCTION heroloop_api.seeker_partner_quest_claim(uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_partner_quest_claim(uuid,uuid,bigint,bigint) TO heroloop_api;

CREATE OR REPLACE FUNCTION heroloop_api.seeker_quest_claim(p_player uuid,p_key uuid,p_id text,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE q jsonb; s public.player_saves; e public.quest_claim_events; instance text; resources jsonb; result jsonb;
BEGIN
 IF p_id NOT LIKE 'skr-%' THEN RETURN public.seeker_settle_quest_claim(p_player,p_key,p_id,p_revision); END IF;
 PERFORM public.assert_account_value_allowed(p_player);
 PERFORM pg_advisory_xact_lock(hashtextextended('quest-claim:'||p_player::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 SELECT * INTO e FROM public.quest_claim_events WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF e.player_id<>p_player OR e.quest_id<>p_id OR e.expected_revision<>p_revision THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  SELECT * INTO s FROM public.player_saves WHERE player_id=p_player;
  RETURN e.result||jsonb_build_object('state',s.state,'revision',s.revision,'replayed',true);
 END IF;
 SELECT * INTO s FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
 IF s.revision<>p_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
 SELECT value INTO q FROM jsonb_array_elements(heroloop_api.seeker_quest_status(p_player)->'quests') WHERE value->>'id'=p_id;
 IF q IS NULL THEN RAISE EXCEPTION 'quest_unknown'; END IF;
 IF (q->>'claimed')::boolean THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
 IF (q->>'progress')::numeric<(q->>'target')::bigint THEN RAISE EXCEPTION 'quest_incomplete'; END IF;
 instance:=CASE WHEN q->>'kind'='daily' THEN 'daily:'||p_id||':'||to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') ELSE p_id END;
 IF (q#>>'{reward,summonScrolls}')::bigint>0 THEN
  resources:=public.apply_resource_entries(p_player,p_key,'quest_claim',encode(extensions.digest(instance::bytea,'sha256'),'hex'),
   jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',q#>>'{reward,summonScrolls}','source_key','summon_milestone_scroll')),s.revision+1);
  s.state:=jsonb_set(s.state,'{summonScrolls}',resources#>'{balances,summon_scroll}',true);
 END IF;
 s.state:=jsonb_set(s.state,'{gold}',to_jsonb(COALESCE((s.state->>'gold')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 s.state:=jsonb_set(s.state,'{totalGoldEarned}',to_jsonb(COALESCE((s.state->>'totalGoldEarned')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 UPDATE public.player_saves SET state=s.state,revision=revision+1,updated_at=now() WHERE player_id=p_player RETURNING * INTO s;
 result:=jsonb_build_object('quest_id',p_id,'claimed',true,'reward',q->'reward','state',s.state,'revision',s.revision,'replayed',false);
 INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result) VALUES(p_key,p_player,instance,p_id,p_revision,(result-'state')||jsonb_build_object('rules_version','seeker-quest-compact-v1','state_hash',encode(extensions.digest(s.state::text,'sha256'),'hex')));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.seeker_quest_claim_before_compact_receipt(uuid,uuid,text,bigint),public.seeker_activity_quest_catalogue(),public.seeker_settle_quest_claim(uuid,uuid,text,bigint),heroloop_api.seeker_quest_status(uuid),heroloop_api.seeker_quest_claim(uuid,uuid,text,bigint),heroloop_api.seeker_purchase_record_payment(uuid,uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_quest_status(uuid),heroloop_api.seeker_quest_claim(uuid,uuid,text,bigint),heroloop_api.seeker_purchase_record_payment(uuid,uuid,numeric) TO heroloop_api;
COMMIT;
