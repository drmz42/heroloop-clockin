-- Founder 2026-10-12: the Seeker tutorial grants no Gold and no potions. It keeps the 10 Tutorial
-- Chests (items), 2 Summon Scrolls and the Boss Key the story fight needs; other steps only advance.
BEGIN;
CREATE FUNCTION pg_temp.tutorial_patch(d text, old text, replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'tutorial_reward_patch_anchor_mismatch: %',left(old,100);
  END IF;
  RETURN replace(d,old,replacement);
END $$;

DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.settle_tutorial_quest_claim_before_delivery(uuid,uuid,text,bigint)'::regprocedure);
  d:=pg_temp.tutorial_patch(d,$old$  v_reward := CASE v_ordinal
    WHEN 1 THEN '{"tutorialChests":10}'::jsonb WHEN 2 THEN '{"gold":500}'::jsonb
    WHEN 3 THEN '{"summonScrolls":2}'::jsonb WHEN 4 THEN '{"summonScrolls":1}'::jsonb
    WHEN 5 THEN '{"potions":{"xs":3}}'::jsonb WHEN 6 THEN '{"gold":500}'::jsonb
    WHEN 7 THEN '{"potions":{"xs":3}}'::jsonb WHEN 8 THEN '{"bossKeys":1}'::jsonb
    WHEN 9 THEN '{"gold":1000}'::jsonb ELSE '{"summonScrolls":1,"tutorialComplete":true}'::jsonb END;$old$,
  $new$  v_reward := CASE v_ordinal
    WHEN 1 THEN '{"tutorialChests":10}'::jsonb WHEN 3 THEN '{"summonScrolls":2}'::jsonb
    WHEN 8 THEN '{"bossKeys":1}'::jsonb WHEN 10 THEN '{"tutorialComplete":true}'::jsonb ELSE '{}'::jsonb END;$new$);
  d:=pg_temp.tutorial_patch(d,$old$    WHEN 4 THEN '[{"resource_id":"summon_scroll","delta":"1","source_key":"tutorial_summon_scroll"}]'::jsonb
    WHEN 5 THEN '[{"resource_id":"potion_xs","delta":"3","source_key":"tutorial_potion"}]'::jsonb
    WHEN 7 THEN '[{"resource_id":"potion_xs","delta":"3","source_key":"tutorial_potion"}]'::jsonb
    WHEN 8 THEN '[{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key"}]'::jsonb
    WHEN 10 THEN '[{"resource_id":"summon_scroll","delta":"1","source_key":"tutorial_summon_scroll"}]'::jsonb
    ELSE '[]'::jsonb END;$old$,
  $new$    WHEN 8 THEN '[{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key"}]'::jsonb
    ELSE '[]'::jsonb END;$new$);
  -- A step without a reward sends no empty letter.
  d:=pg_temp.tutorial_patch(d,$old$  PERFORM public.mail_quest_reward(p_player_id,p_quest_id,v_reward,v_entries);$old$,
  $new$  IF jsonb_array_length(v_entries)>0 OR COALESCE((v_reward->>'gold')::bigint,0)>0 THEN
   PERFORM public.mail_quest_reward(p_player_id,p_quest_id,v_reward,v_entries);
  END IF;$new$);
  EXECUTE d;
END $patch$;
COMMIT;
