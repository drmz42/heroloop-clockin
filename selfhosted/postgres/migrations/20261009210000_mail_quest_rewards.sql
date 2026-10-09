-- Seeker quest receipts retain eligibility/progression while rewards wait for claim.
BEGIN;
CREATE FUNCTION pg_temp.mail_patch(d text, old text, replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'mail_reward_patch_anchor_mismatch: %',left(old,100);
  END IF;
  RETURN replace(d,old,replacement);
END $$;

CREATE FUNCTION public.mail_quest_reward(p_player uuid,p_ref text,p_reward jsonb,p_entries jsonb DEFAULT '[]')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE attachments jsonb:='[]'; entry jsonb;
BEGIN
 IF COALESCE((p_reward->>'gold')::bigint,0)>0 THEN
  attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','gold','amount',(p_reward->>'gold')::bigint));
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
  attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','resource','resource_id',entry->>'resource_id','amount',(entry->>'delta')::bigint));
 END LOOP;
 IF jsonb_array_length(p_entries)=0 AND COALESCE((p_reward->>'summonScrolls')::bigint,0)>0 THEN
  attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','resource','resource_id','summon_scroll','amount',(p_reward->>'summonScrolls')::bigint));
 END IF;
 RETURN public.mail_send_letter(p_player,'system','Quests','Quest rewards','Your rewards are attached. Claim them when you are ready.',
  'quest:'||encode(extensions.digest(p_ref,'sha256'),'hex'),attachments);
END $$;
REVOKE ALL ON FUNCTION public.mail_quest_reward(uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text; signature text; reward_block text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['heroloop_api.seeker_quest_claim(uuid,uuid,text,bigint)','public.seeker_challenge_claim(uuid,uuid,text,bigint)'] LOOP
  d:=pg_get_functiondef(signature::regprocedure);
  d:=pg_temp.mail_patch(d,' SELECT * INTO s FROM public.player_saves WHERE player_id=p_player FOR UPDATE;',
    E' PERFORM 1 FROM public.players WHERE player_id=p_player FOR UPDATE;\n SELECT * INTO s FROM public.player_saves WHERE player_id=p_player FOR UPDATE;');
  reward_block:=$block$ IF (q#>>'{reward,summonScrolls}')::bigint>0 THEN
  resources:=public.apply_resource_entries(p_player,p_key,'quest_claim',encode(extensions.digest(instance::bytea,'sha256'),'hex'),
   jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',q#>>'{reward,summonScrolls}','source_key','summon_milestone_scroll')),s.revision+1);
  s.state:=jsonb_set(s.state,'{summonScrolls}',resources#>'{balances,summon_scroll}',true);
 END IF;
 s.state:=jsonb_set(s.state,'{gold}',to_jsonb(COALESCE((s.state->>'gold')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
 s.state:=jsonb_set(s.state,'{totalGoldEarned}',to_jsonb(COALESCE((s.state->>'totalGoldEarned')::bigint,0)+(q#>>'{reward,gold}')::bigint),true);
$block$;
  IF signature LIKE 'public.seeker_challenge%' THEN reward_block:=replace(reward_block,'digest(instance::bytea','digest(p_id::bytea'); END IF;
  d:=pg_temp.mail_patch(d,reward_block,
   $new$ IF to_regclass('public.seeker_progression_settings') IS NOT NULL THEN
    PERFORM public.mail_quest_reward(p_player,p_id||':'||p_key,q->'reward');
   ELSE
$new$||reward_block||E' END IF;\n');
  d:=pg_temp.mail_patch(d,'''claimed'',true,''reward'',q->''reward'',', '''claimed'',true,''mailed'',to_regclass(''public.seeker_progression_settings'') IS NOT NULL,''reward'',q->''reward'',');
  EXECUTE d;
 END LOOP;
 d:=pg_get_functiondef('public.seeker_quest_claim_before_compact_receipt(uuid,uuid,text,bigint)'::regprocedure);
 d:=pg_temp.mail_patch(d,'  SELECT * INTO v_save FROM public.player_saves',
   E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT * INTO v_save FROM public.player_saves');
 d:=pg_temp.mail_patch(d,$old$  v_entries := CASE WHEN v_scrolls>0 THEN jsonb_build_array(jsonb_build_object('resource_id','summon_scroll','delta',v_scrolls::text,'source_key','summon_milestone_scroll')) ELSE '[]'::jsonb END;
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

$old$,$new$ IF to_regclass('public.seeker_progression_settings') IS NOT NULL THEN
  PERFORM public.mail_quest_reward(p_player_id,v_instance,v_reward);
  v_resource:=public.resource_snapshot(p_player_id);
  v_gold:=GREATEST(0,COALESCE((v_state->>'gold')::bigint,0));
 ELSE
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

 END IF;
$new$);
 EXECUTE d;
 d:=pg_get_functiondef('public.settle_tutorial_quest_claim(uuid,uuid,text,bigint)'::regprocedure);
 d:=pg_temp.mail_patch(d,'  SELECT * INTO v_save FROM public.player_saves',
   E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT * INTO v_save FROM public.player_saves');
 d:=pg_temp.mail_patch(d,$old$  IF jsonb_array_length(v_entries)>0 THEN
    v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'tutorial_quest_claim',
      encode(extensions.digest((p_quest_id||':'||p_expected_revision::text)::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  ELSE v_resource := public.resource_snapshot(p_player_id); END IF;
$old$,$new$ IF to_regclass('public.seeker_progression_settings') IS NOT NULL THEN
  PERFORM public.mail_quest_reward(p_player_id,p_quest_id,v_reward,v_entries);
  v_gold:=GREATEST(0,COALESCE((v_state->>'gold')::bigint,0));
  v_resource:=public.resource_snapshot(p_player_id);
 ELSE
  IF jsonb_array_length(v_entries)>0 THEN
    v_resource := public.apply_resource_entries(p_player_id,p_idempotency_key,'tutorial_quest_claim',
      encode(extensions.digest((p_quest_id||':'||p_expected_revision::text)::bytea,'sha256'),'hex'),v_entries,v_save.revision+1);
  ELSE v_resource := public.resource_snapshot(p_player_id); END IF;
 END IF;
$new$);
 d:=pg_temp.mail_patch(d,'''claimed'',true,''reward'',v_reward,', '''claimed'',true,''mailed'',to_regclass(''public.seeker_progression_settings'') IS NOT NULL,''reward'',v_reward,');
 EXECUTE d;
END
$patch$;
DO $patch$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('heroloop_api.premium_boss_claim(uuid,uuid,bigint,uuid)'::regprocedure);
 d:=pg_temp.mail_patch(d,'  r:=public.boss_claim(',
   E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  r:=public.boss_claim(');
 d:=pg_temp.mail_patch(d,$old$  receipt:=public.apply_resource_entries(p_player_id,p_idempotency_key,'premium_potion_reward',
    encode(extensions.digest(jsonb_build_object('encounter_id',p_encounter_id)::text,'sha256'),'hex'),
    '[{"resource_id":"premium_potion_weak","delta":"1","source_key":"premium_potion_reward"}]',
    (r->>'save_revision')::bigint);
$old$,$new$ IF to_regclass('public.seeker_progression_settings') IS NOT NULL THEN
  PERFORM public.mail_send_letter(p_player_id,'system','Boss Hunt','Boss potion reward','Your reward is attached.',
   'premium-boss:'||p_encounter_id,'[{"kind":"resource","resource_id":"premium_potion_weak","amount":1}]');
 ELSE
  receipt:=public.apply_resource_entries(p_player_id,p_idempotency_key,'premium_potion_reward',
    encode(extensions.digest(jsonb_build_object('encounter_id',p_encounter_id)::text,'sha256'),'hex'),
    '[{"resource_id":"premium_potion_weak","delta":"1","source_key":"premium_potion_reward"}]',
    (r->>'save_revision')::bigint);
 END IF;
$new$);
 d:=pg_temp.mail_patch(d,'''premium_potions_awarded'',1,', '''premium_potions_awarded'',1,''premium_potions_mailed'',to_regclass(''public.seeker_progression_settings'') IS NOT NULL,');
 EXECUTE d;
END
$patch$;
DO $locks$
DECLARE d text;
BEGIN
 d:=pg_get_functiondef('public.settle_tutorial_chest_open(uuid,uuid,integer)'::regprocedure);
 d:=pg_temp.mail_patch(d,'  SELECT * INTO v_save FROM public.player_saves',
  E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT * INTO v_save FROM public.player_saves');
 EXECUTE d;
END
$locks$;
COMMIT;
