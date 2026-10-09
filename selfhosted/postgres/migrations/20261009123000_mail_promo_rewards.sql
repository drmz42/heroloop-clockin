-- Seeker promo rewards wait in letters; resource claims use the shared Reward Catalog.
BEGIN;
CREATE FUNCTION pg_temp.mail_patch(p_definition text,p_old text,p_new text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_old='' OR length(p_definition)-length(replace(p_definition,p_old,'')) <> length(p_old) THEN
    RAISE EXCEPTION 'mail_promo_patch_anchor_mismatch';
  END IF;
  RETURN replace(p_definition,p_old,p_new);
END $$;

DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.redeem_promo_code(uuid,text,uuid)'::regprocedure);
  d:=pg_temp.mail_patch(d,'  v_revision bigint;',E'  v_revision bigint;\n  v_mail boolean := to_regclass(''public.seeker_progression_settings'') IS NOT NULL;\n  v_attachments jsonb := ''[]''::jsonb;');
  d:=pg_temp.mail_patch(d,'  SELECT * INTO v_save FROM public.player_saves',
    E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT * INTO v_save FROM public.player_saves');
  d:=pg_temp.mail_patch(d,$old$v_hero := COALESCE((v_code.rewards->>'hero')::numeric, 0);$old$,
    $new$v_hero := CASE WHEN v_mail THEN 0 ELSE COALESCE((v_code.rewards->>'hero')::numeric, 0) END;$new$);
  d:=pg_temp.mail_patch(d,$old$  v_balance := v_balance + v_hero;$old$,$new$  IF v_mail THEN
    IF v_gold>0 THEN v_attachments:=v_attachments||jsonb_build_array(jsonb_build_object('kind','gold','amount',v_gold)); END IF;
    IF v_scrolls>0 THEN v_attachments:=v_attachments||jsonb_build_array(jsonb_build_object(
      'kind','resource','resource_id','summon_scroll','amount',v_scrolls,'title','Summon Scroll')); END IF;
    IF v_boss_keys>0 THEN v_attachments:=v_attachments||jsonb_build_array(jsonb_build_object(
      'kind','resource','resource_id','boss_key','amount',v_boss_keys,'title','Boss Key')); END IF;
    IF jsonb_array_length(v_attachments)>0 THEN
      PERFORM public.mail_send_letter(p_player_id,'system','HeroLoop','Promo code reward',
        'Your promo rewards are attached. Claim them when you are ready.','promo:'||v_code.id,v_attachments);
    END IF;
    IF v_chests>0 THEN
      PERFORM public.mail_send_chest_bundle(p_player_id,v_chests,LEAST(20,GREATEST(1,COALESCE((v_save.state->>'highestLocation')::integer,1))),
        'HeroLoop','Promo code chest rewards','promo-chests:'||v_code.id);
    END IF;
  END IF;
  v_balance := v_balance + v_hero;$new$);
  d:=pg_temp.mail_patch(d,$old$  v_state := jsonb_set(v_state, '{gold}',$old$,$new$  IF NOT v_mail THEN
  v_state := jsonb_set(v_state, '{gold}',$new$);
  d:=pg_temp.mail_patch(d,'  UPDATE public.players SET token_balance = v_balance, updated_at = now() WHERE player_id = p_player_id;',
    E'  END IF;\n  UPDATE public.players SET token_balance = v_balance, updated_at = now() WHERE player_id = p_player_id;');
  d:=pg_temp.mail_patch(d,$old$    'label', v_code.label,$old$,$new$    'label', v_code.label, 'mailed', v_mail,$new$);
  EXECUTE d;

  d:=pg_get_functiondef('public.resource_promo_redemption_trigger()'::regprocedure);
  d:=pg_temp.mail_patch(d,E'BEGIN\n',E'BEGIN\n  IF COALESCE((NEW.result->>''mailed'')::boolean,false) THEN RETURN NEW; END IF;\n');
  EXECUTE d;
END
$patch$;
DROP FUNCTION pg_temp.mail_patch(text,text,text);
COMMIT;
