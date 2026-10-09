-- Seeker promo rewards wait in letters. Resource attachment IDs are their ledger replay keys.
BEGIN;
ALTER TABLE public.player_mail_rewards DROP CONSTRAINT player_mail_rewards_kind_check;
ALTER TABLE public.player_mail_rewards ADD CONSTRAINT player_mail_rewards_kind_check CHECK (kind IN ('chest','gold','resource'));

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
  d:=pg_get_functiondef('public.mail_attachment_payload(jsonb)'::regprocedure);
  d:=pg_temp.mail_patch(d,E'BEGIN\n',$new$BEGIN
  IF p_attachment->>'kind'='resource' THEN
    IF jsonb_typeof(p_attachment->'amount') IS DISTINCT FROM 'number'
      OR (p_attachment->>'amount')::numeric NOT BETWEEN 1 AND 10000
      OR (p_attachment->>'amount')::numeric <> trunc((p_attachment->>'amount')::numeric)
      OR NOT COALESCE((p_attachment->>'resource_id',p_attachment->>'action',p_attachment->>'source_key') IN (
        ('summon_scroll','promo_code','promo_summon_scroll'),('boss_key','promo_code','promo_boss_key'),
        ('summon_scroll','dungeon_scroll_claim','boss_summon_scroll'),
        ('summon_scroll','partner_quest_claim','partner_quest_reward'),('boss_key','partner_quest_claim','partner_quest_reward')
      ),false) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('resource_id',p_attachment->>'resource_id','amount',(p_attachment->>'amount')::bigint,
      'action',p_attachment->>'action','source_key',p_attachment->>'source_key');
  END IF;
$new$);
  EXECUTE d;

  d:=pg_get_functiondef('heroloop_api.mail_claim(uuid,uuid,uuid)'::regprocedure);
  d:=pg_temp.mail_patch(d,'  v_gold bigint := 0;',E'  v_gold bigint := 0;\n  v_resource jsonb;\n  v_resources_full boolean := false;');
  d:=pg_temp.mail_patch(d,'  SELECT state, revision INTO v_state, v_revision FROM public.player_saves',
    E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT state, revision INTO v_state, v_revision FROM public.player_saves');
  d:=pg_temp.mail_patch(d,$old$'gold', COALESCE((state->>'gold')::bigint, 0), 'revision', revision)$old$,
    $new$'gold', COALESCE((state->>'gold')::bigint, 0), 'revision', revision,
      'summon_scrolls',COALESCE((state->>'summonScrolls')::bigint,0),'boss_keys',COALESCE((state->>'bossKeys')::bigint,0))$new$);
  d:=pg_temp.mail_patch(d,$old$        v_gold := v_gold + (v_reward.payload->>'amount')::bigint;$old$,$new$        v_gold := v_gold + (v_reward.payload->>'amount')::bigint;
      ELSIF v_reward.kind = 'resource' THEN
        BEGIN
          v_resource:=public.apply_resource_entries(p_player_id,v_reward.id,v_reward.payload->>'action',
            encode(extensions.digest(v_reward.payload::text,'sha256'),'hex'),
            jsonb_build_array(jsonb_build_object('resource_id',v_reward.payload->>'resource_id',
              'delta',v_reward.payload->>'amount','source_key',v_reward.payload->>'source_key')),v_revision+1);
        EXCEPTION WHEN raise_exception THEN
          IF SQLERRM='resource_balance_cap' THEN v_resources_full:=true; CONTINUE; ELSE RAISE; END IF;
        END;
        v_state:=jsonb_set(jsonb_set(v_state,'{summonScrolls}',to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint),true),
          '{bossKeys}',to_jsonb((v_resource#>>'{balances,boss_key}')::bigint),true);
        UPDATE public.players SET boss_keys=(v_resource#>>'{balances,boss_key}')::integer WHERE player_id=p_player_id;
      ELSE
        RAISE EXCEPTION 'invalid_mail_attachment';$new$);
  d:=pg_temp.mail_patch(d,$old$'gold_claimed', v_gold);$old$,$new$'gold_claimed', v_gold, 'resources_full', v_resources_full);$new$);
  d:=pg_temp.mail_patch(d,'AND NOT v_changed AND v_items_full AND NOT v_chests_full',
    'AND NOT v_changed AND v_items_full AND NOT v_chests_full AND NOT v_resources_full');
  d:=pg_temp.mail_patch(d,$old$'gold', COALESCE((v_state->>'gold')::bigint, 0));$old$,
    $new$'gold', COALESCE((v_state->>'gold')::bigint, 0),
      'summon_scrolls',COALESCE((v_state->>'summonScrolls')::bigint,0),'boss_keys',COALESCE((v_state->>'bossKeys')::bigint,0));$new$);
  EXECUTE d;

  d:=pg_get_functiondef('public.redeem_promo_code(uuid,text,uuid)'::regprocedure);
  d:=pg_temp.mail_patch(d,'  v_revision bigint;',E'  v_revision bigint;\n  v_mail boolean := to_regclass(''public.seeker_progression_settings'') IS NOT NULL;\n  v_attachments jsonb := ''[]''::jsonb;');
  d:=pg_temp.mail_patch(d,'  SELECT * INTO v_save FROM public.player_saves',
    E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT * INTO v_save FROM public.player_saves');
  d:=pg_temp.mail_patch(d,$old$v_hero := COALESCE((v_code.rewards->>'hero')::numeric, 0);$old$,
    $new$v_hero := CASE WHEN v_mail THEN 0 ELSE COALESCE((v_code.rewards->>'hero')::numeric, 0) END;$new$);
  d:=pg_temp.mail_patch(d,$old$  v_balance := v_balance + v_hero;$old$,$new$  IF v_mail THEN
    IF v_gold>0 THEN v_attachments:=v_attachments||jsonb_build_array(jsonb_build_object('kind','gold','amount',v_gold)); END IF;
    IF v_scrolls>0 THEN v_attachments:=v_attachments||jsonb_build_array(jsonb_build_object(
      'kind','resource','resource_id','summon_scroll','amount',v_scrolls,'action','promo_code','source_key','promo_summon_scroll')); END IF;
    IF v_boss_keys>0 THEN v_attachments:=v_attachments||jsonb_build_array(jsonb_build_object(
      'kind','resource','resource_id','boss_key','amount',v_boss_keys,'action','promo_code','source_key','promo_boss_key')); END IF;
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
