-- Delivery changes only: preserve chest rolls, source receipts and Event amounts.
BEGIN;
ALTER TABLE public.player_mail_items DROP CONSTRAINT player_mail_items_source_check;
ALTER TABLE public.player_mail_items ADD CONSTRAINT player_mail_items_source_check
  CHECK (source IN ('market_purchase','market_return','store_overflow','chest_reward'));

CREATE FUNCTION pg_temp.mail_patch(d text, old text, replacement text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF old='' OR length(d)-length(replace(d,old,''))<>length(old) THEN
    RAISE EXCEPTION 'mail_reward_patch_anchor_mismatch';
  END IF;
  RETURN replace(d,old,replacement);
END $$;
DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  d:=pg_temp.mail_patch(d,'  v_existing public.chest_open_events%ROWTYPE;',
    E'  v_mailed boolean := to_regclass(''public.seeker_progression_settings'') IS NOT NULL;\n  v_existing public.chest_open_events%ROWTYPE;');
  -- Use the same players -> save lock order as Mailbox claim/resource settlement.
  d:=pg_temp.mail_patch(d,'  SELECT state INTO v_state',
    E'  PERFORM 1 FROM public.players WHERE player_id=p_player_id FOR UPDATE;\n  SELECT state INTO v_state');
  d:=pg_temp.mail_patch(d,'IF v_bag_count + p_count > public.inventory_bag_capacity(v_state) THEN',
    'IF NOT v_mailed AND v_bag_count + p_count > public.inventory_bag_capacity(v_state) THEN');
  d:=pg_temp.mail_patch(d,'    v_inventory := v_inventory || jsonb_build_array(v_item);',
    $new$    IF v_mailed THEN
      PERFORM public.mail_deliver_item(p_player_id,v_item_id,'chest_reward',p_idempotency_key::text);
    ELSE
      v_inventory := v_inventory || jsonb_build_array(v_item);
    END IF;$new$);
  d:=pg_temp.mail_patch(d,'''chest_count'', p_count,', '''chest_count'', p_count, ''mailed'', v_mailed,');
  EXECUTE d;
END
$patch$;

-- All Event callers already serialize and record the source claim/payment once.
-- The original direct implementation stays available for standard-policy fixtures.
ALTER FUNCTION public.seeker_event_grant(uuid,uuid,text,jsonb) RENAME TO seeker_event_grant_direct;
CREATE FUNCTION public.seeker_event_grant(p_player uuid,p_key uuid,p_action text,p_reward jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.player_saves; attachments jsonb:='[]'; v_gold bigint:=COALESCE((p_reward->>'gold')::bigint,0);
  v_scrolls bigint:=COALESCE((p_reward->>'scrolls')::bigint,0); v_keys bigint:=COALESCE((p_reward->>'boss_keys')::bigint,0);
  v_chests integer:=COALESCE((p_reward->>'chests')::integer,0); offset_count integer;
BEGIN
  IF to_regclass('public.seeker_progression_settings') IS NULL THEN
    RETURN public.seeker_event_grant_direct(p_player,p_key,p_action,p_reward);
  END IF;
  IF v_gold<0 OR v_scrolls<0 OR v_keys<0 OR v_chests<0 THEN RAISE EXCEPTION 'invalid_event_reward'; END IF;
  PERFORM 1 FROM public.players WHERE player_id=p_player FOR UPDATE;
  SELECT * INTO s FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_gold>0 THEN attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','gold','amount',v_gold)); END IF;
  IF v_scrolls>0 THEN attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','resource','resource_id','summon_scroll','amount',v_scrolls)); END IF;
  IF v_keys>0 THEN attachments:=attachments||jsonb_build_array(jsonb_build_object('kind','resource','resource_id','boss_key','amount',v_keys)); END IF;
  IF jsonb_array_length(attachments)>0 THEN
    PERFORM public.mail_send_letter(p_player,'system','Events','Event rewards',
      'Your rewards are attached. Claim them when you are ready.','event:'||p_key,attachments);
  END IF;
  IF v_chests>0 THEN
    FOR offset_count IN 0..((v_chests-1)/50) LOOP
      PERFORM public.mail_send_chest_bundle(p_player,LEAST(50,v_chests-offset_count*50),
        LEAST(20,GREATEST(1,COALESCE((s.state->>'currentLocation')::integer,1))),
        'Events','Event chest rewards','event-chests:'||p_key||':'||offset_count);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('state',s.state,'revision',s.revision,'mailed',true);
END $$;
REVOKE ALL ON FUNCTION public.seeker_event_grant_direct(uuid,uuid,text,jsonb),
  public.seeker_event_grant(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Keep the mail flag in the compact receipt so replays have the same delivery message.
DO $patch$
DECLARE d text;
BEGIN
  d:=pg_get_functiondef('heroloop_api.seeker_event_claim(uuid,uuid,text,text)'::regprocedure);
  d:=pg_temp.mail_patch(d,$old$'reward', v_reward, 'claimed', true)$old$,
    $new$'reward', v_reward, 'claimed', true, 'mailed', COALESCE((v_granted->>'mailed')::boolean,false))$new$);
  EXECUTE d;
END
$patch$;
COMMIT;
