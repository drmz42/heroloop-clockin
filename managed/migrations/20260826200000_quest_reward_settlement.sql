CREATE TABLE IF NOT EXISTS public.quest_claim_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  instance_key text NOT NULL,
  quest_id text NOT NULL,
  expected_revision bigint NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, instance_key)
);
CREATE INDEX IF NOT EXISTS quest_claim_events_player_idx ON public.quest_claim_events(player_id, created_at DESC);
ALTER TABLE public.quest_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quest_claim_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.quest_daily_catalogue()
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT '[
    {"id":"kill-1000","kind":"daily","label":"Defeat 1,000 enemies","target":1000,"progress":0,"reward":{"gold":1000,"hero":2},"claimed":false},
    {"id":"kill-10000","kind":"daily","label":"Defeat 10,000 enemies","target":10000,"progress":0,"reward":{"gold":5000,"hero":8},"claimed":false},
    {"id":"boss-1","kind":"daily","label":"Defeat 1 boss","target":1,"progress":0,"reward":{"gold":500,"hero":2},"claimed":false},
    {"id":"boss-3","kind":"daily","label":"Defeat 3 bosses","target":3,"progress":0,"reward":{"gold":2000,"hero":5},"claimed":false},
    {"id":"chest-50","kind":"daily","label":"Open 50 chests","target":50,"progress":0,"reward":{"gold":1000,"hero":2},"claimed":false},
    {"id":"chest-250","kind":"daily","label":"Open 250 chests","target":250,"progress":0,"reward":{"gold":4000,"hero":6},"claimed":false},
    {"id":"summon-1","kind":"daily","label":"Summon 1 hero","target":1,"progress":0,"reward":{"gold":300,"hero":1},"claimed":false},
    {"id":"summon-10","kind":"daily","label":"Summon 10 heroes","target":10,"progress":0,"reward":{"gold":1500,"hero":3},"claimed":false},
    {"id":"summon-50","kind":"daily","label":"Summon 50 heroes","target":50,"progress":0,"reward":{"gold":5000,"hero":10},"claimed":false}
  ]'::jsonb
$$;

CREATE OR REPLACE FUNCTION public.quest_advance_prefix(p_quests jsonb, p_prefix text, p_amount bigint)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(CASE WHEN quest->>'id' LIKE p_prefix || '%'
    THEN jsonb_set(quest, '{progress}', to_jsonb(GREATEST(0, COALESCE((quest->>'progress')::bigint, 0) + GREATEST(0, p_amount))), true)
    ELSE quest END ORDER BY ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_quests) = 'array' THEN p_quests ELSE '[]'::jsonb END)
    WITH ORDINALITY AS entries(quest, ordinal)
$$;

CREATE OR REPLACE FUNCTION public.sync_quest_progress_before_save()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  v_day text := to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  v_old_day text;
  v_daily jsonb;
  v_milestones jsonb;
  v_delta bigint;
BEGIN
  v_old_day := to_char(to_timestamp(COALESCE((OLD.state->>'lastQuestReset')::numeric, 0) / 1000)
    AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  IF v_old_day IS DISTINCT FROM v_day THEN
    v_daily := public.quest_daily_catalogue();
    NEW.state := jsonb_set(NEW.state, '{lastQuestReset}', to_jsonb(v_now_ms), true);
  ELSE
    v_daily := COALESCE(NEW.state->'dailyQuests', public.quest_daily_catalogue());
  END IF;

  v_delta := GREATEST(0, COALESCE((NEW.state->>'totalKills')::bigint, 0) - COALESCE((OLD.state->>'totalKills')::bigint, 0));
  IF v_delta > 0 AND (v_old_day IS DISTINCT FROM v_day OR NEW.state->'dailyQuests' = OLD.state->'dailyQuests') THEN
    v_daily := public.quest_advance_prefix(v_daily, 'kill-', v_delta);
  END IF;
  v_delta := GREATEST(0, COALESCE((NEW.state->>'totalBossKills')::bigint, 0) - COALESCE((OLD.state->>'totalBossKills')::bigint, 0));
  IF v_delta > 0 AND (v_old_day IS DISTINCT FROM v_day OR NEW.state->'dailyQuests' = OLD.state->'dailyQuests') THEN
    v_daily := public.quest_advance_prefix(v_daily, 'boss-', v_delta);
  END IF;
  v_delta := GREATEST(0, COALESCE((NEW.state->>'summons')::bigint, 0) - COALESCE((OLD.state->>'summons')::bigint, 0));
  IF v_delta > 0 AND (v_old_day IS DISTINCT FROM v_day OR NEW.state->'dailyQuests' = OLD.state->'dailyQuests') THEN
    v_daily := public.quest_advance_prefix(v_daily, 'summon-', v_delta);
  END IF;
  IF v_old_day IS DISTINCT FROM v_day THEN
    v_delta := GREATEST(0, COALESCE((NEW.state->>'chestsOpenedToday')::bigint, 0));
    IF v_delta > 0 THEN v_daily := public.quest_advance_prefix(v_daily, 'chest-', v_delta); END IF;
  END IF;
  NEW.state := jsonb_set(NEW.state, '{dailyQuests}', v_daily, true);

  v_delta := GREATEST(0, COALESCE((NEW.state->>'summons')::bigint, 0) - COALESCE((OLD.state->>'summons')::bigint, 0));
  v_milestones := COALESCE(NEW.state->'milestoneQuests', '[]'::jsonb);
  IF v_delta > 0 AND NEW.state->'milestoneQuests' = OLD.state->'milestoneQuests' THEN
    v_milestones := public.quest_advance_prefix(v_milestones, 'milestone-summon-', v_delta);
    NEW.state := jsonb_set(NEW.state, '{milestoneQuests}', v_milestones, true);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS player_saves_sync_quest_progress ON public.player_saves;
CREATE TRIGGER player_saves_sync_quest_progress BEFORE UPDATE OF state ON public.player_saves
FOR EACH ROW EXECUTE FUNCTION public.sync_quest_progress_before_save();

CREATE OR REPLACE FUNCTION public.settle_quest_claim(
  p_player_id uuid, p_idempotency_key uuid, p_quest_id text, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.quest_claim_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb; v_quests jsonb; v_next_quests jsonb; v_quest jsonb; v_reward jsonb;
  v_family text; v_instance text; v_day text := to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  v_last_day text; v_gold bigint; v_hero numeric; v_scrolls bigint; v_balance numeric;
  v_entries jsonb; v_resource jsonb; v_revision bigint; v_result jsonb; v_next jsonb := 'null'::jsonb;
  v_tier integer; v_target bigint; v_next_target bigint; v_next_scrolls bigint; v_chain text; v_label text;
  v_token_earned numeric; v_token_spent numeric; v_player_summons bigint; v_player_chests bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('quest-claim:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.quest_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.quest_id <> p_quest_id OR v_existing.expected_revision <> p_expected_revision THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT token_balance,boost_tokens_earned,boost_tokens_spent,summons,chests_opened
  INTO v_balance,v_token_earned,v_token_spent,v_player_summons,v_player_chests
  FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  v_state := v_save.state;

  IF p_quest_id LIKE 'milestone-%' THEN
    v_family := 'milestone'; v_quests := COALESCE(v_state->'milestoneQuests', '[]'::jsonb);
    SELECT value INTO v_quest FROM jsonb_array_elements(v_quests) WHERE value->>'id' = p_quest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'quest_unknown'; END IF;
    v_chain := v_quest->>'chain';
    v_tier := COALESCE((v_quest->>'tier')::integer, -1);
    v_target := CASE v_chain
      WHEN 'chest' THEN (ARRAY[1000,5000,25000]::bigint[])[v_tier+1]
      WHEN 'kill' THEN (ARRAY[50000,250000,1000000]::bigint[])[v_tier+1]
      WHEN 'boss' THEN (ARRAY[25,100,500]::bigint[])[v_tier+1]
      WHEN 'summon' THEN (ARRAY[10,100,1000,10000]::bigint[])[v_tier+1]
      WHEN 'token-earned' THEN (ARRAY[1000,10000,100000]::bigint[])[v_tier+1]
      WHEN 'token-spent' THEN (ARRAY[500,5000,50000]::bigint[])[v_tier+1]
      WHEN 'gold-earned' THEN (ARRAY[100000,1000000,10000000]::bigint[])[v_tier+1]
      WHEN 'hero-owned' THEN (ARRAY[25,100,200]::bigint[])[v_tier+1] ELSE NULL END;
    IF v_target IS NULL OR (v_quest->>'target')::bigint <> v_target OR p_quest_id <> 'milestone-'||v_chain||'-'||v_target::text THEN RAISE EXCEPTION 'quest_catalogue_mismatch'; END IF;
    v_quest := jsonb_set(v_quest,'{progress}',to_jsonb(CASE v_chain
      WHEN 'chest' THEN GREATEST(COALESCE((v_quest->>'progress')::bigint,0),COALESCE(v_player_chests,0))
      WHEN 'kill' THEN COALESCE((v_state->>'totalKills')::bigint,0)
      WHEN 'boss' THEN COALESCE((v_state->>'totalBossKills')::bigint,0)
      WHEN 'summon' THEN GREATEST(COALESCE((v_state->>'summons')::bigint,0),COALESCE(v_player_summons,0))
      WHEN 'token-earned' THEN floor(COALESCE(v_token_earned,0))::bigint
      WHEN 'token-spent' THEN floor(COALESCE(v_token_spent,0))::bigint
      WHEN 'gold-earned' THEN COALESCE((v_state->>'totalGoldEarned')::bigint,0)
      WHEN 'hero-owned' THEN jsonb_array_length(COALESCE(v_state->'ownedHeroes','[]'::jsonb)) ELSE 0 END),true);
    v_scrolls := CASE WHEN v_chain='summon' THEN (ARRAY[1,5,10,50]::bigint[])[v_tier+1] ELSE 0 END;
    v_reward := CASE WHEN v_chain='summon' THEN jsonb_build_object('gold',0,'hero',0,'summonScrolls',v_scrolls)
      ELSE jsonb_build_object('gold',GREATEST(2500,floor(v_target/10.0)::bigint),'hero',5*(v_tier+1)) END;
    v_instance := p_quest_id;
  ELSE
    v_family := 'daily'; v_quests := CASE WHEN jsonb_typeof(v_state->'dailyQuests')='array' AND jsonb_array_length(v_state->'dailyQuests')>0 THEN v_state->'dailyQuests' ELSE public.quest_daily_catalogue() END;
    v_last_day := to_char(to_timestamp(COALESCE((v_state->>'lastQuestReset')::numeric, 0) / 1000) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
    IF v_last_day IS DISTINCT FROM v_day THEN
      v_state := jsonb_set(jsonb_set(v_state,'{dailyQuests}',public.quest_daily_catalogue(),true),'{lastQuestReset}',to_jsonb(floor(extract(epoch FROM clock_timestamp())*1000)::bigint),true);
      UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
      RETURN jsonb_build_object('quest_id',p_quest_id,'family','daily','claimed',false,'code','quest_day_stale','state',v_state,'revision',v_revision,'replayed',false);
    END IF;
    SELECT value INTO v_quest FROM jsonb_array_elements(v_quests) WHERE value->>'id' = p_quest_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'quest_unknown'; END IF;
    SELECT value->'reward' INTO v_reward FROM jsonb_array_elements(public.quest_daily_catalogue()) WHERE value->>'id'=p_quest_id AND value->>'target'=v_quest->>'target';
    IF v_reward IS NULL THEN RAISE EXCEPTION 'quest_catalogue_mismatch'; END IF;
    v_gold := COALESCE((v_reward->>'gold')::bigint,0); v_hero := COALESCE((v_reward->>'hero')::numeric,0); v_scrolls := 0;
    v_instance := 'daily:' || p_quest_id || ':' || v_day;
  END IF;
  IF COALESCE((v_quest->>'claimed')::boolean,false) THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
  IF COALESCE((v_quest->>'progress')::bigint,0) < COALESCE((v_quest->>'target')::bigint,0) THEN RAISE EXCEPTION 'quest_incomplete'; END IF;
  IF v_family='milestone' THEN v_gold:=COALESCE((v_reward->>'gold')::bigint,0); v_hero:=COALESCE((v_reward->>'hero')::numeric,0); END IF;

  IF EXISTS (SELECT 1 FROM public.quest_claim_events WHERE player_id=p_player_id AND instance_key=v_instance) THEN RAISE EXCEPTION 'quest_already_claimed'; END IF;
  v_entries := CASE WHEN v_scrolls>0 THEN jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',v_scrolls::text,'source_key','summon_milestone_scroll')) ELSE '[]'::jsonb END;
  IF v_scrolls>0 THEN
    v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'quest_claim',encode(extensions.digest((v_instance||':'||p_expected_revision)::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  ELSE v_resource := public.resource_snapshot(p_player_id); END IF;
  v_balance := v_balance + v_hero;
  v_gold := GREATEST(0,COALESCE((v_state->>'gold')::bigint,0)) + v_gold;
  v_state := jsonb_set(v_state,'{gold}',to_jsonb(v_gold),true);
  v_state := jsonb_set(v_state,'{hero}',to_jsonb(v_balance),true);
  v_state := jsonb_set(v_state,'{totalGoldEarned}',to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint,0)+COALESCE((v_reward->>'gold')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{totalTokensEarned}',to_jsonb(COALESCE((v_state->>'totalTokensEarned')::numeric,0)+v_hero),true);
  v_state := jsonb_set(v_state,'{tokensEarnedToday}',to_jsonb(CASE WHEN v_state->>'tokenDayKey'=v_day THEN COALESCE((v_state->>'tokensEarnedToday')::numeric,0)+v_hero ELSE v_hero END),true);
  v_state := jsonb_set(v_state,'{tokenDayKey}',to_jsonb(v_day),true);
  v_state := jsonb_set(v_state,'{session,goldToday}',to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint,0)+COALESCE((v_reward->>'gold')::bigint,0)),true);
  v_state := jsonb_set(v_state,'{session,heroToday}',to_jsonb(COALESCE((v_state#>>'{session,heroToday}')::numeric,0)+v_hero),true);
  v_state := jsonb_set(v_state,'{summonScrolls}',to_jsonb(COALESCE((v_resource#>>'{balances,summon_scroll}')::bigint,0)),true);

  IF v_family='daily' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN value->>'id'=p_quest_id THEN jsonb_set(value,'{claimed}','true'::jsonb,true) ELSE value END ORDER BY ord),'[]'::jsonb)
    INTO v_next_quests FROM jsonb_array_elements(v_quests) WITH ORDINALITY e(value,ord);
    v_state := jsonb_set(v_state,'{dailyQuests}',v_next_quests,true);
  ELSE
    v_next_target := CASE v_chain
      WHEN 'chest' THEN (ARRAY[5000,25000]::bigint[])[v_tier+1] WHEN 'kill' THEN (ARRAY[250000,1000000]::bigint[])[v_tier+1]
      WHEN 'boss' THEN (ARRAY[100,500]::bigint[])[v_tier+1] WHEN 'summon' THEN (ARRAY[100,1000,10000]::bigint[])[v_tier+1]
      WHEN 'token-earned' THEN (ARRAY[10000,100000]::bigint[])[v_tier+1] WHEN 'token-spent' THEN (ARRAY[5000,50000]::bigint[])[v_tier+1]
      WHEN 'gold-earned' THEN (ARRAY[1000000,10000000]::bigint[])[v_tier+1] WHEN 'hero-owned' THEN (ARRAY[100,200]::bigint[])[v_tier+1] ELSE NULL END;
    v_next_scrolls := CASE WHEN v_chain='summon' THEN (ARRAY[5,10,50]::bigint[])[v_tier+1] ELSE NULL END;
    v_label := CASE v_chain WHEN 'chest' THEN 'Open ' WHEN 'kill' THEN 'Defeat ' WHEN 'boss' THEN 'Defeat ' WHEN 'summon' THEN 'Summon '
      WHEN 'token-earned' THEN 'Earn ' WHEN 'token-spent' THEN 'Spend ' WHEN 'gold-earned' THEN 'Earn ' WHEN 'hero-owned' THEN 'Own ' END;
    v_label := v_label||to_char(v_next_target,'FM999,999,999')||CASE v_chain WHEN 'chest' THEN ' chests' WHEN 'kill' THEN ' enemies' WHEN 'boss' THEN ' bosses' WHEN 'summon' THEN ' heroes' WHEN 'token-earned' THEN ' $HERO' WHEN 'token-spent' THEN ' $HERO' WHEN 'gold-earned' THEN ' Gold' WHEN 'hero-owned' THEN ' heroes' END;
    IF v_next_target IS NOT NULL THEN v_next := jsonb_build_object('id','milestone-'||v_chain||'-'||v_next_target,'kind','milestone','chain',v_chain,'tier',v_tier+1,'label',v_label,'target',v_next_target,'progress',(v_quest->>'progress')::bigint,'reward',CASE WHEN v_chain='summon' THEN jsonb_build_object('gold',0,'hero',0,'summonScrolls',v_next_scrolls) ELSE jsonb_build_object('gold',GREATEST(2500,floor(v_next_target/10.0)::bigint),'hero',5*(v_tier+2)) END,'claimed',false); END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO v_next_quests FROM jsonb_array_elements(v_quests) WITH ORDINALITY e(value,ord) WHERE value->>'id'<>p_quest_id;
    IF v_next_target IS NOT NULL THEN v_next_quests:=v_next_quests||jsonb_build_array(v_next); END IF;
    v_state := jsonb_set(v_state,'{milestoneQuests}',v_next_quests,true);
  END IF;
  UPDATE public.players SET token_balance=v_balance, boost_tokens_earned=boost_tokens_earned+v_hero, updated_at=now() WHERE player_id=p_player_id;
  IF v_hero>0 THEN INSERT INTO public.hero_economy_ledger(flow,source_kind,source_key,player_id,amount,metadata)
    VALUES('player_issuance','quest-reward','quest:'||v_instance,p_player_id,v_hero,jsonb_build_object('quest_id',p_quest_id,'family',v_family)); END IF;
  UPDATE public.player_saves SET state=v_state,revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING revision INTO v_revision;
  v_result:=jsonb_build_object('quest_id',p_quest_id,'family',v_family,'claimed',true,'reward',v_reward,'gold',v_gold,'token_balance',v_balance,'resources',v_resource,'next_milestone',v_next,'state',v_state,'revision',v_revision,'replayed',false);
  INSERT INTO public.quest_claim_events(idempotency_key,player_id,instance_key,quest_id,expected_revision,result) VALUES(p_idempotency_key,p_player_id,v_instance,p_quest_id,p_expected_revision,v_result);
  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.quest_daily_catalogue() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.quest_advance_prefix(jsonb,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sync_quest_progress_before_save() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.settle_quest_claim(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_quest_claim(uuid,uuid,text,bigint) TO service_role;
