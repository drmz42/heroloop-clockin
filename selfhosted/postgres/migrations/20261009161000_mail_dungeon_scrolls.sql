-- Seeker Dungeon completion delivers the existing eligible Scroll reward to Mailbox.
-- Dungeon Chest, Gold and XP previews remain non-minting.
BEGIN;
CREATE FUNCTION pg_temp.mail_dungeon_patch(p_definition text,p_old text,p_new text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_old='' OR length(p_definition)-length(replace(p_definition,p_old,'')) <> length(p_old) THEN
    RAISE EXCEPTION 'mail_dungeon_patch_anchor_mismatch';
  END IF;
  RETURN replace(p_definition,p_old,p_new);
END $$;
DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.dungeon_room_complete(uuid,uuid,bigint,uuid)'::regprocedure);
  d:=pg_temp.mail_dungeon_patch(d,'  v_reward_rank bigint;',
    E'  v_mail boolean := to_regclass(''public.seeker_progression_settings'') IS NOT NULL;\n  v_reward_rank bigint;');
  d:=pg_temp.mail_dungeon_patch(d,'      SELECT * INTO v_save FROM public.player_saves',
    E'      PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n      SELECT * INTO v_save FROM public.player_saves');
  d:=pg_temp.mail_dungeon_patch(d,$old$      v_resource:=public.apply_resource_entries(p_player_id,p_idempotency_key,'dungeon_scroll_claim',
        encode(extensions.digest(jsonb_build_object('encounter_id',v_encounter.id,'scrolls',2)::text,'sha256'),'hex'),
        '[{"resource_id":"summon_scroll","delta":"2","source_key":"boss_summon_scroll"}]'::jsonb,
        v_save.revision+1);
      UPDATE public.player_saves SET
        state=jsonb_set(state,'{summonScrolls}',to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint),true),
        revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING * INTO v_save;$old$,$new$      IF v_mail THEN
        PERFORM public.mail_send_letter(p_player_id,'system','Dungeon','Dungeon Scroll reward',
          'Your victory rewards are attached. Claim them when you are ready.',
          'dungeon-scrolls:' || v_encounter.id,
          '[{"kind":"resource","resource_id":"summon_scroll","amount":2}]'::jsonb);
      ELSE
      v_resource:=public.apply_resource_entries(p_player_id,p_idempotency_key,'dungeon_scroll_claim',
        encode(extensions.digest(jsonb_build_object('encounter_id',v_encounter.id,'scrolls',2)::text,'sha256'),'hex'),
        '[{"resource_id":"summon_scroll","delta":"2","source_key":"boss_summon_scroll"}]'::jsonb,
        v_save.revision+1);
      UPDATE public.player_saves SET
        state=jsonb_set(state,'{summonScrolls}',to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint),true),
        revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING * INTO v_save;
      END IF;$new$);
  d:=pg_temp.mail_dungeon_patch(d,'''rewards_enabled'',v_scrolls=2,''scrolls_awarded'',v_scrolls,',
    '''rewards_enabled'',v_scrolls=2,''scrolls_awarded'',v_scrolls,''rewards_mailed'',v_mail AND v_scrolls=2,');
  -- A mailed completion changes no save. Do not store/replay an obsolete save snapshot.
  d:=pg_temp.mail_dungeon_patch(d,'CASE WHEN v_scrolls=2 THEN v_save.state ELSE NULL END',
    'CASE WHEN v_scrolls=2 AND NOT v_mail THEN v_save.state ELSE NULL END');
  EXECUTE d;
END
$patch$;
DROP FUNCTION pg_temp.mail_dungeon_patch(text,text,text);
COMMIT;
