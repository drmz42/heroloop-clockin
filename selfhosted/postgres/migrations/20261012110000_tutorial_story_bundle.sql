-- Founder 2026-10-12: after the story's second death the tutorial pays one bundle in one letter:
-- 20 Tutorial Chests, 2 Summon Scrolls and 1 Boss Key (step 1). Every other step pays nothing;
-- steps that would need a third summon or long grinds now complete with the two-hero squad, and the
-- softened tutorial boss (with key refund) applies from step 2 because the key arrives at step 1.
BEGIN;
CREATE FUNCTION pg_temp.tutorial_patch(d text, old text, replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'tutorial_bundle_patch_anchor_mismatch: %',left(old,100);
  END IF;
  RETURN replace(d,old,replacement);
END $$;

DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.settle_tutorial_quest_claim_before_delivery(uuid,uuid,text,bigint)'::regprocedure);
  d:=pg_temp.tutorial_patch(d,$old$v_targets bigint[] := ARRAY[10,10,1,2,3,3,25,1,50,1];$old$,$new$v_targets bigint[] := ARRAY[10,10,1,2,3,2,10,1,10,1];$new$);
  d:=pg_temp.tutorial_patch(d,$old$    WHEN 1 THEN '{"tutorialChests":10}'::jsonb WHEN 3 THEN '{"summonScrolls":2}'::jsonb
    WHEN 8 THEN '{"bossKeys":1}'::jsonb WHEN 10 THEN '{"tutorialComplete":true}'::jsonb ELSE '{}'::jsonb END;$old$,
  $new$    WHEN 1 THEN '{"tutorialChests":20,"summonScrolls":2,"bossKeys":1}'::jsonb
    WHEN 10 THEN '{"tutorialComplete":true}'::jsonb ELSE '{}'::jsonb END;$new$);
  d:=pg_temp.tutorial_patch(d,$old$    WHEN 1 THEN '[{"resource_id":"tutorial_chest","delta":"10","source_key":"tutorial_chest"}]'::jsonb
    WHEN 3 THEN '[{"resource_id":"summon_scroll","delta":"2","source_key":"tutorial_summon_scroll"}]'::jsonb
    WHEN 8 THEN '[{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key"}]'::jsonb
    ELSE '[]'::jsonb END;$old$,
  $new$    WHEN 1 THEN '[{"resource_id":"tutorial_chest","delta":"20","source_key":"tutorial_chest"},{"resource_id":"summon_scroll","delta":"2","source_key":"tutorial_summon_scroll"},{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key"}]'::jsonb
    ELSE '[]'::jsonb END;$new$);
  d:=pg_temp.tutorial_patch(d,$old$IF v_ordinal=8 THEN v_state := jsonb_set(v_state,'{tutorial,bossKillsAtKeyGrant}'$old$,
    $new$IF v_ordinal=1 THEN v_state := jsonb_set(v_state,'{tutorial,bossKillsAtKeyGrant}'$new$);
  EXECUTE d;

  d:=pg_get_functiondef('public.tutorial_boss_eligible(jsonb)'::regprocedure);
  d:=pg_temp.tutorial_patch(d,$old$::integer, 11) IN (9, 10)$old$,$new$::integer, 11) BETWEEN 2 AND 10$new$);
  EXECUTE d;

  d:=pg_get_functiondef('public.tutorial_boss_key_regrant(uuid,uuid)'::regprocedure);
  d:=pg_temp.tutorial_patch(d,$old$::integer, 1) NOT IN (9, 10)$old$,$new$::integer, 1) NOT BETWEEN 2 AND 10$new$);
  EXECUTE d;
END $patch$;
COMMIT;
