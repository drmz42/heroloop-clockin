-- Preserve grant receipts while keeping identical pending rewards in one letter.
BEGIN;
ALTER TABLE public.periodic_chest_events DROP CONSTRAINT periodic_chest_events_blocked_capacity_check;
ALTER TABLE public.periodic_chest_events ADD CONSTRAINT periodic_chest_events_blocked_capacity_check CHECK(blocked_capacity BETWEEN 0 AND 1000);
ALTER TABLE public.player_mail_letters ADD COLUMN merged_into uuid REFERENCES public.player_mail_letters(id);

CREATE FUNCTION public.mail_stack_signature(p_letter uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_agg(signature ORDER BY signature::text) FROM (
    SELECT DISTINCT jsonb_build_object('kind',kind,'payload',payload-'amount') signature
    FROM public.player_mail_rewards WHERE letter_id=p_letter AND claimed_at IS NULL
  ) rewards
$$;
REVOKE ALL ON FUNCTION public.mail_stack_signature(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.mail_stack_letter(p_letter uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE incoming public.player_mail_letters; target uuid; signature jsonb;
BEGIN
  IF to_regclass('public.seeker_progression_settings') IS NULL THEN RETURN p_letter; END IF;
  SELECT * INTO incoming FROM public.player_mail_letters WHERE id=p_letter;
  IF incoming.merged_into IS NOT NULL THEN RETURN incoming.merged_into; END IF;
  IF incoming.deleted_at IS NOT NULL OR incoming.claimed_at IS NOT NULL THEN RETURN p_letter; END IF;
  PERFORM 1 FROM public.player_saves WHERE player_id=incoming.player_id FOR UPDATE;
  signature:=public.mail_stack_signature(p_letter);
  IF signature IS NULL THEN RETURN p_letter; END IF;
  SELECT id INTO target FROM public.player_mail_letters l
    WHERE l.player_id=incoming.player_id AND l.deleted_at IS NULL AND l.claimed_at IS NULL
      AND l.source=incoming.source AND l.sender=incoming.sender AND l.title=incoming.title AND l.body=incoming.body
      AND (l.created_at,l.id)<(incoming.created_at,incoming.id)
      AND public.mail_stack_signature(l.id)=signature
    ORDER BY l.created_at,l.id LIMIT 1 FOR UPDATE;
  IF target IS NULL THEN RETURN p_letter; END IF;
  UPDATE public.player_mail_rewards SET letter_id=target WHERE letter_id=p_letter AND claimed_at IS NULL;
  UPDATE public.player_mail_letters SET read_at=NULL WHERE id=target;
  -- Keep the donor as a hidden receipt so its source_ref and old client id survive.
  UPDATE public.player_mail_letters SET merged_into=target,deleted_at=clock_timestamp(),
    claimed_at=clock_timestamp(),read_at=COALESCE(read_at,clock_timestamp()) WHERE id=p_letter;
  RETURN target;
END $$;
REVOKE ALL ON FUNCTION public.mail_stack_letter(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.periodic_chest_capacity(p_player uuid,p_state jsonb)
RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT GREATEST(0,500-(
    SELECT count(*) FROM jsonb_array_elements(COALESCE(p_state->'chests','[]')) chest
    WHERE (chest->>'stage')::integer=GREATEST(1,COALESCE((p_state->>'currentLocation')::integer,1))
      AND NOT COALESCE((chest->>'boss')::boolean,false)
  )-(
    SELECT count(*) FROM public.player_mail_rewards r
    WHERE r.player_id=p_player AND r.claimed_at IS NULL AND r.kind='chest'
      AND (r.payload->>'stage')::integer=GREATEST(1,COALESCE((p_state->>'currentLocation')::integer,1))
      AND NOT COALESCE((r.payload->>'boss')::boolean,false)
  ))::integer
$$;
REVOKE ALL ON FUNCTION public.periodic_chest_capacity(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION pg_temp.mail_capacity_patch(d text,old text,replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'mail_stacking_capacity_anchor_mismatch: %',left(old,100);
  END IF;
  RETURN replace(d,old,replacement);
END $$;
DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.mail_send_letter(uuid,text,text,text,text,text,jsonb)'::regprocedure);
  IF position('  IF NULLIF(current_setting(''heroloop.gameplay_delivery_ids''' IN d)>0 THEN
    d:=pg_temp.mail_capacity_patch(d,'  IF NULLIF(current_setting(''heroloop.gameplay_delivery_ids''',
      E'  IF NULLIF(current_setting(''heroloop.gameplay_delivery_ids'',true),'''') IS NULL THEN v_id:=public.mail_stack_letter(v_id); END IF;\n  IF NULLIF(current_setting(''heroloop.gameplay_delivery_ids''');
  ELSE
    d:=pg_temp.mail_capacity_patch(d,'  RETURN v_id;',E'  v_id:=public.mail_stack_letter(v_id);\n  RETURN v_id;');
  END IF;
  EXECUTE d;
  IF to_regprocedure('public.settle_gameplay_delivery(uuid,uuid[])') IS NOT NULL THEN
    d:=pg_get_functiondef('public.settle_gameplay_delivery(uuid,uuid[])'::regprocedure);
    -- Deliver only this request's rewards first; consolidate its remaining overflow afterwards.
    d:=pg_temp.mail_capacity_patch(d,'  SELECT count(*)>0,',
      E'  FOREACH target_id IN ARRAY p_letters LOOP PERFORM public.mail_stack_letter(target_id); END LOOP;\n  SELECT count(*)>0,');
    d:=pg_temp.mail_capacity_patch(d,'DECLARE letter record;', 'DECLARE target_id uuid; letter record;');
    d:=pg_temp.mail_capacity_patch(d,'l.id=ANY(p_letters)',
      '(l.id=ANY(p_letters) OR l.id IN (SELECT merged_into FROM public.player_mail_letters WHERE player_id=p_player AND id=ANY(p_letters)))');
    EXECUTE d;
  END IF;
  d:=pg_get_functiondef('public.settle_periodic_progression_legacy(uuid,timestamptz)'::regprocedure);
  d:=pg_temp.mail_capacity_patch(d,
    'CASE WHEN v_mail_chests THEN 1000 ELSE GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->''chests'', ''[]''::jsonb))) END,',
    'CASE WHEN v_mail_chests THEN public.periodic_chest_capacity(p_player_id,v_state) ELSE GREATEST(0, 500 - jsonb_array_length(COALESCE(v_state->''chests'', ''[]''::jsonb))) END,');
  EXECUTE d;
  d:=pg_get_functiondef('public.settle_periodic_progression_before_pending_normal_recovery(uuid,timestamptz)'::regprocedure);
  -- Snapshot mail reservations before settlement adds its new attachments.
  d:=pg_temp.mail_capacity_patch(d,
    '  v_result := public.settle_periodic_progression_before_economy_telemetry(p_player_id, p_tick);',
    $new$  v_capacity_available := CASE WHEN to_regclass('public.seeker_progression_settings') IS NOT NULL
      THEN public.periodic_chest_capacity(p_player_id,v_before_state)
      ELSE GREATEST(0,500-jsonb_array_length(COALESCE(v_before_state->'chests','[]'::jsonb))) END;
  v_result := public.settle_periodic_progression_before_economy_telemetry(p_player_id, p_tick);$new$);
  d:=pg_temp.mail_capacity_patch(d,
    $old$v_capacity_available := CASE WHEN to_regclass('public.seeker_progression_settings') IS NOT NULL THEN 1000
      ELSE GREATEST(0, 500 - jsonb_array_length(COALESCE(v_before_state->'chests', '[]'::jsonb))) END;$old$,
    '-- Capacity was captured before issuing new mail.');
  EXECUTE d;
  d:=pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  -- Resolve old ids after the replay check; the receipt retains the submitted id.
  d:=pg_temp.mail_capacity_patch(d,
    '  IF NOT FOUND THEN RAISE EXCEPTION ''save_not_found''; END IF;',
    E'  IF NOT FOUND THEN RAISE EXCEPTION ''save_not_found''; END IF;\n  p_mail_id:=COALESCE((SELECT merged_into FROM public.player_mail_letters WHERE id=p_mail_id AND player_id=p_player_id),p_mail_id);');
  d:=pg_temp.mail_capacity_patch(d,
    'IF jsonb_array_length(v_chests) >= 500 THEN v_chests_full := true; CONTINUE; END IF;',
    $new$IF (CASE WHEN to_regclass('public.seeker_progression_settings') IS NOT NULL
          AND NOT COALESCE((v_reward.payload->>'boss')::boolean,false) THEN
          (SELECT count(*) FROM jsonb_array_elements(v_chests) c
            WHERE c->>'stage'=v_reward.payload->>'stage' AND NOT COALESCE((c->>'boss')::boolean,false))
          ELSE jsonb_array_length(v_chests) END) >= 500 THEN v_chests_full := true; CONTINUE; END IF;$new$);
  EXECUTE d;
  d:=pg_get_functiondef('heroloop_api.mail_read(uuid,uuid)'::regprocedure);
  d:=pg_temp.mail_capacity_patch(d,'  UPDATE public.player_mail_letters SET read_at',
    E'  p_letter_id:=COALESCE((SELECT merged_into FROM public.player_mail_letters WHERE id=p_letter_id AND player_id=p_player_id),p_letter_id);\n  UPDATE public.player_mail_letters SET read_at');
  EXECUTE d;
END $patch$;

DO $backfill$
DECLARE letter record;
BEGIN
  FOR letter IN SELECT id FROM public.player_mail_letters
    WHERE deleted_at IS NULL AND claimed_at IS NULL ORDER BY player_id,created_at,id
  LOOP PERFORM public.mail_stack_letter(letter.id); END LOOP;
END $backfill$;
COMMIT;
