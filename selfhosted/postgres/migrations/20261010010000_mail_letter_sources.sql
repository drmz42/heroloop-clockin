-- Founder 2026-10-09: every reward letter says what it is for and where it came from (the quest by name,
-- the Login Calendar, Weekly Event or Battle Pass, the dungeon, the promo code, the partner quest).
-- Text only: rewards, attachments, idempotency and source refs stay exactly as before.
-- Gameplay sources keep their original bodies in the *_before_delivery copies (20261009220000).
BEGIN;
CREATE FUNCTION pg_temp.mail_text_patch(d text, old text, replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'mail_letter_source_anchor_mismatch: %',left(old,100);
  END IF;
  RETURN replace(d,old,replacement);
END $$;

CREATE OR REPLACE FUNCTION public.mail_event_label(p_action text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_action WHEN 'seeker_event_calendar' THEN 'Login Calendar' WHEN 'seeker_event_weekly' THEN 'Weekly Event'
    WHEN 'seeker_event_pass' THEN 'Battle Pass' WHEN 'seeker_event_collector' THEN 'Collector Pass' ELSE 'Events' END
$$;
REVOKE ALL ON FUNCTION public.mail_event_label(text) FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE d text; signature text;
BEGIN
  -- Events: name the event the reward came from.
  d:=pg_get_functiondef('public.seeker_event_grant_before_delivery(uuid,uuid,text,jsonb)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$public.mail_send_letter(p_player,'system','Events','Event rewards',
      'Your rewards are attached. Claim them when you are ready.',$old$,
    $new$public.mail_send_letter(p_player,'system','Events',public.mail_event_label(p_action)||' reward',
      'Your reward from the '||public.mail_event_label(p_action)||'. Claim it when you are ready.',$new$);
  d:=pg_temp.mail_text_patch(d,$old$'Events','Event chest rewards',$old$,$new$'Events',public.mail_event_label(p_action)||' chests',$new$);
  EXECUTE d;

  -- Quests: the letter names the completed quest when the claim passes its label.
  d:=pg_get_functiondef('public.mail_quest_reward(uuid,text,jsonb,jsonb)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$'Quests','Quest rewards','Your rewards are attached. Claim them when you are ready.',$old$,
    $new$'Quests',left(COALESCE('Quest: '||NULLIF(p_reward->>'mail_label',''),'Quest reward'),120),
  COALESCE('Reward for completing the quest "'||NULLIF(p_reward->>'mail_label','')||'". Claim it when you are ready.',
   'Reward for a completed quest. Claim it when you are ready.'),$new$);
  EXECUTE d;
  FOREACH signature IN ARRAY ARRAY['heroloop_api.seeker_quest_claim_before_delivery(uuid,uuid,text,bigint)','public.seeker_challenge_claim_before_delivery(uuid,uuid,text,bigint)'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    d:=pg_temp.mail_text_patch(d,$old$mail_quest_reward(p_player,p_id||':'||p_key,q->'reward');$old$,
      $new$mail_quest_reward(p_player,p_id||':'||p_key,q->'reward'||jsonb_build_object('mail_label',q->>'label'));$new$);
    EXECUTE d;
  END LOOP;
  d:=pg_get_functiondef('public.seeker_quest_claim_before_compact_receip_before_delivery(uuid,uuid,text,bigint)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$mail_quest_reward(p_player_id,v_instance,v_reward);$old$,
    $new$mail_quest_reward(p_player_id,v_instance,v_reward||jsonb_build_object('mail_label',v_quest->>'label'));$new$);
  EXECUTE d;

  -- Premium Boss potion.
  d:=pg_get_functiondef('heroloop_api.premium_boss_claim_before_delivery(uuid,uuid,bigint,uuid)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$'Boss Hunt','Boss potion reward','Your reward is attached.',$old$,
    $new$'Boss Hunt','Premium Boss reward','A bonus potion for your Premium Boss victory. Claim it when you are ready.',$new$);
  EXECUTE d;

  -- Dungeon Summon Scrolls.
  d:=pg_get_functiondef('public.dungeon_room_complete_before_delivery(uuid,uuid,bigint,uuid)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$'Dungeon','Dungeon Scroll reward',
          'Your victory rewards are attached. Claim them when you are ready.',$old$,
    $new$'Dungeon','Dungeon victory reward',
          'Summon Scrolls for clearing a dungeon. Claim them when you are ready.',$new$);
  EXECUTE d;

  -- Promo codes.
  d:=pg_get_functiondef('public.redeem_promo_code_before_delivery(uuid,text,uuid)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$'Your promo rewards are attached. Claim them when you are ready.'$old$,
    $new$'Reward for redeeming a promo code. Claim it when you are ready.'$new$);
  EXECUTE d;

  -- Partner quests: name the quest.
  d:=pg_get_functiondef('heroloop_api.seeker_partner_quest_claim_before_delivery(uuid,uuid,bigint,bigint)'::regprocedure);
  d:=pg_temp.mail_text_patch(d,$old$'Partner Quests','Partner quest reward',
      'Your approved rewards are attached. Claim them when you are ready.',$old$,
    $new$'Partner Quests',left(COALESCE('Partner quest: '||(SELECT pq.title FROM public.partner_quests pq WHERE pq.id=v_submission.quest_id),'Partner quest reward'),120),
      left(COALESCE('Reward for the approved partner quest "'||(SELECT pq.title FROM public.partner_quests pq WHERE pq.id=v_submission.quest_id)||'". ','Reward for an approved partner quest. ')||'Claim it when you are ready.',2000),$new$);
  EXECUTE d;
END
$patch$;
COMMIT;
