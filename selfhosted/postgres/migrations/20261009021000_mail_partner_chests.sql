-- Seeker partner chest rewards wait in the Mailbox rather than requiring chest queue room.
BEGIN;

CREATE OR REPLACE FUNCTION public.mail_send_chest_bundle(p_player uuid, p_count integer, p_stage integer,
  p_sender text, p_title text, p_source_ref text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_offset integer; v_attachments jsonb;
BEGIN
  IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 50 OR p_stage IS NULL OR p_stage NOT BETWEEN 1 AND 20
    OR p_source_ref IS NULL OR char_length(p_source_ref) NOT BETWEEN 1 AND 70 THEN
    RAISE EXCEPTION 'invalid_mail_chest_bundle';
  END IF;
  -- A letter allows 20 attachments; preserve the existing 50-chest quest maximum.
  FOR v_offset IN 0..((p_count - 1) / 20) LOOP
    SELECT jsonb_agg(jsonb_build_object('kind','chest','stage',p_stage)) INTO v_attachments
      FROM generate_series(1, LEAST(20, p_count - v_offset * 20));
    PERFORM public.mail_send_letter(p_player,'system',p_sender,p_title,
      'Your chest rewards are attached. Claim them when your chest queue has room.',
      p_source_ref || ':part:' || v_offset, v_attachments);
  END LOOP;
END
$function$;
REVOKE ALL ON FUNCTION public.mail_send_chest_bundle(uuid,integer,integer,text,text,text) FROM PUBLIC;

DO $patch$
DECLARE v_definition text; v_updated text;
BEGIN
  v_definition := pg_get_functiondef('heroloop_api.seeker_partner_quest_claim(uuid,uuid,bigint,bigint)'::regprocedure);
  v_updated := replace(v_definition, $old$
  IF v_chests > 0 THEN
    IF jsonb_typeof(COALESCE(v_state->'chests', '[]'::jsonb)) <> 'array'
      OR jsonb_array_length(COALESCE(v_state->'chests', '[]'::jsonb)) + v_chests > 500 THEN
      RAISE EXCEPTION 'chest_capacity_exceeded';
    END IF;
    v_stage := GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1));
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) ||
      (SELECT jsonb_agg(jsonb_build_object('stage', v_stage)) FROM generate_series(1, v_chests)), true);
  END IF;
$old$, $new$
  IF v_chests > 0 THEN
    v_stage := LEAST(20, GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1)));
    PERFORM public.mail_send_chest_bundle(p_player_id,v_chests,v_stage,
      'Partner Quests','Partner quest reward','partner-quest:' || v_submission.id);
  END IF;
$new$);
  IF v_updated = v_definition THEN RAISE EXCEPTION 'seeker_partner_mail_chest_patch_failed'; END IF;
  EXECUTE v_updated;
END
$patch$;

COMMIT;
