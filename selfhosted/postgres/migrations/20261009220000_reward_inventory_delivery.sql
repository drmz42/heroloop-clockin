-- Gameplay rewards settle into available storage in the source transaction.
-- Existing mail and explicit Founder letters remain available for manual claim.
BEGIN;
DO $patch$
DECLARE d text; old text := 'v_mailed boolean := to_regclass(''public.seeker_progression_settings'') IS NOT NULL;';
BEGIN
  d := pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  IF length(d)-length(replace(d,old,'')) <> length(old) THEN
    RAISE EXCEPTION 'chest_inventory_delivery_anchor_mismatch';
  END IF;
  -- Opening requires one free bag slot per chest; failure precedes any roll/debit.
  EXECUTE replace(d,old,'v_mailed boolean := false;');
END
$patch$;

-- Capture only letters created by this source transaction, without changing its
-- encounter/save/player lock order or sweeping another request's pending rewards.
DO $capture$
DECLARE d text; old text := '  RETURN v_id;';
BEGIN
  d:=pg_get_functiondef('public.mail_send_letter(uuid,text,text,text,text,text,jsonb)'::regprocedure);
  IF length(d)-length(replace(d,old,''))<>length(old) THEN RAISE EXCEPTION 'reward_delivery_capture_anchor_mismatch'; END IF;
  EXECUTE replace(d,old,$new$  IF NULLIF(current_setting('heroloop.gameplay_delivery_ids',true),'') IS NOT NULL THEN
    PERFORM set_config('heroloop.gameplay_delivery_ids',
      (current_setting('heroloop.gameplay_delivery_ids')::jsonb||to_jsonb(v_id))::text,true);
  END IF;
  RETURN v_id;$new$);
END
$capture$;

CREATE FUNCTION public.settle_gameplay_delivery(p_player uuid, p_letters uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE letter record; result jsonb; pending boolean; chest_pending boolean; gold_pending boolean; resource_pending boolean;
BEGIN
  FOR letter IN SELECT id, claimed_at FROM public.player_mail_letters
    WHERE player_id=p_player AND id=ANY(p_letters) AND source IN ('system','boss_reward')
    ORDER BY created_at,id
  LOOP
    IF letter.claimed_at IS NULL THEN
      -- Reuse canonical caps, ledger ownership, resource projection and partial claim.
      BEGIN
        result:=heroloop_api.mail_claim(p_player,gen_random_uuid(),letter.id);
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'item_capacity_exceeded' THEN RAISE; END IF;
      END;
    END IF;
    UPDATE public.player_mail_letters SET read_at=COALESCE(read_at,clock_timestamp()),
      deleted_at=COALESCE(deleted_at,clock_timestamp())
    WHERE id=letter.id AND claimed_at IS NOT NULL;
  END LOOP;
  SELECT count(*)>0, count(*) FILTER(WHERE r.kind='chest')>0,
    count(*) FILTER(WHERE r.kind='gold')>0, count(*) FILTER(WHERE r.kind='resource')>0
  INTO pending,chest_pending,gold_pending,resource_pending
  FROM public.player_mail_rewards r JOIN public.player_mail_letters l ON l.id=r.letter_id
  WHERE l.player_id=p_player AND l.id=ANY(p_letters) AND l.source IN ('system','boss_reward') AND r.claimed_at IS NULL;
  RETURN jsonb_build_object('mailed',pending,'chests_mailed',chest_pending,'gold_mailed',gold_pending,'resources_mailed',resource_pending);
END
$function$;
REVOKE ALL ON FUNCTION public.settle_gameplay_delivery(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role,heroloop_api,heroloop_worker;

-- Wrap only reviewed gameplay sources, keeping original signatures, owners and ACLs.
-- The private copies retain eligibility, amounts, rolls, request validation and replay.
DO $wrappers$
DECLARE spec record; fn record; d text; private_name text; calls text; body text; receipt_sql text; replay_sql text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('public.settle_periodic_progression(uuid,timestamptz)','p_player_id',NULL,NULL,NULL,NULL),
    ('public.seeker_event_grant(uuid,uuid,text,jsonb)','p_player',NULL,NULL,NULL,NULL),
    ('heroloop_api.seeker_quest_claim(uuid,uuid,text,bigint)','p_player','public.quest_claim_events','result','idempotency_key','p_key'),
    ('public.seeker_challenge_claim(uuid,uuid,text,bigint)','p_player','public.quest_claim_events','result','idempotency_key','p_key'),
    ('public.seeker_quest_claim_before_compact_receipt(uuid,uuid,text,bigint)','p_player_id','public.quest_claim_events','result','idempotency_key','p_idempotency_key'),
    ('public.settle_tutorial_quest_claim(uuid,uuid,text,bigint)','p_player_id','public.tutorial_quest_claim_events','result','idempotency_key','p_idempotency_key'),
    ('heroloop_api.seeker_partner_quest_claim(uuid,uuid,bigint,bigint)','p_player_id','public.partner_quest_submissions','claim_result','claim_key','p_idempotency_key'),
    ('public.redeem_promo_code(uuid,text,uuid)','p_player_id','public.promo_code_redemptions','result','idempotency_key','p_idempotency_key'),
    ('public.dungeon_room_complete(uuid,uuid,bigint,uuid)','p_player_id','public.dungeon_events','result','idempotency_key','p_idempotency_key'),
    ('public.boss_claim(uuid,uuid,bigint,uuid)','p_player_id','public.boss_claim_events','result','idempotency_key','p_idempotency_key'),
    ('heroloop_api.premium_boss_claim(uuid,uuid,bigint,uuid)','p_player_id','public.boss_claim_events','result','idempotency_key','p_idempotency_key')
  ) AS sources(signature,player_arg,receipt_table,receipt_column,key_column,key_arg)
  LOOP
    SELECT p.*,n.nspname INTO fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid=spec.signature::regprocedure;
    IF fn.prorettype <> 'jsonb'::regtype OR NOT fn.prosecdef THEN RAISE EXCEPTION 'invalid_reward_source: %',spec.signature; END IF;
    private_name:=left(fn.proname,40)||'_before_delivery';
    d:=pg_get_functiondef(fn.oid);
    EXECUTE replace(d,format('FUNCTION %I.%I(',fn.nspname,fn.proname),format('FUNCTION %I.%I(',fn.nspname,private_name));
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC,anon,authenticated,service_role,heroloop_api,heroloop_worker',
      fn.nspname,private_name,pg_get_function_identity_arguments(fn.oid));
    SELECT string_agg(quote_ident(arg),',') INTO calls FROM unnest(fn.proargnames) arg;
    receipt_sql:=''; replay_sql:='';
    IF spec.receipt_table IS NOT NULL THEN
      replay_sql:=format('IF cardinality(letters)=0 THEN SELECT %2$I->''inventory_delivery'' INTO prior_delivery FROM %3$s WHERE player_id=%1$I AND %4$I=%5$I; delivery:=COALESCE(prior_delivery,delivery); END IF;',
        spec.player_arg,spec.receipt_column,spec.receipt_table,spec.key_column,spec.key_arg);
      -- Compact receipts retain delivery flags only; never add another save snapshot.
      receipt_sql:=format('UPDATE %1$s SET %2$I=%2$I||jsonb_build_object(''inventory_delivery'',delivery) WHERE player_id=%3$I AND %4$I=%5$I;',
        spec.receipt_table,spec.receipt_column,spec.player_arg,spec.key_column,spec.key_arg);
    END IF;
    body:=format($body$
DECLARE prior_ids text; captured jsonb; letters uuid[]; r jsonb; delivery jsonb; prior_delivery jsonb; save public.player_saves;
BEGIN
  IF to_regclass('public.seeker_progression_settings') IS NULL THEN RETURN %2$I.%3$I(%4$s); END IF;
  prior_ids:=NULLIF(current_setting('heroloop.gameplay_delivery_ids',true),'');
  PERFORM set_config('heroloop.gameplay_delivery_ids','[]',true);
  r:=%2$I.%3$I(%4$s);
  captured:=current_setting('heroloop.gameplay_delivery_ids')::jsonb;
  SELECT COALESCE(array_agg(value::uuid),ARRAY[]::uuid[]) INTO letters FROM jsonb_array_elements_text(captured);
  PERFORM set_config('heroloop.gameplay_delivery_ids',CASE WHEN prior_ids IS NULL THEN '' ELSE (prior_ids::jsonb||captured)::text END,true);
  delivery:=public.settle_gameplay_delivery(%1$I,letters);
  %5$s
  %6$s
  SELECT * INTO save FROM public.player_saves WHERE player_id=%1$I;
  IF r ? 'mailed' THEN r:=jsonb_set(r,'{mailed}',delivery->'mailed'); END IF;
  IF r ? 'rewards_mailed' THEN r:=jsonb_set(r,'{rewards_mailed}',delivery->'resources_mailed'); END IF;
  IF r ? 'premium_potions_mailed' THEN r:=jsonb_set(r,'{premium_potions_mailed}',delivery->'resources_mailed'); END IF;
  IF r ? 'chest_delivered_to' THEN r:=jsonb_set(r,'{chest_delivered_to}',to_jsonb(CASE WHEN (delivery->>'chests_mailed')::boolean THEN 'mail' ELSE 'inventory' END)); END IF;
  IF r ? 'gold_delivered_to' THEN r:=jsonb_set(r,'{gold_delivered_to}',to_jsonb(CASE WHEN (delivery->>'gold_mailed')::boolean THEN 'mail' ELSE 'inventory' END)); END IF;
  IF save.player_id IS NOT NULL THEN
    IF r ? 'state' THEN r:=jsonb_set(r,'{state}',save.state); END IF;
    IF r ? 'revision' AND NOT r ? 'encounter_id' THEN r:=jsonb_set(r,'{revision}',to_jsonb(save.revision)); END IF;
    IF r ? 'save_revision' THEN r:=jsonb_set(r,'{save_revision}',to_jsonb(save.revision)); END IF;
    IF r ? 'gold' AND NOT r ? 'encounter_id' AND NOT r ? 'settled_through' THEN r:=jsonb_set(r,'{gold}',save.state->'gold'); END IF;
    IF r ? 'resources' THEN r:=jsonb_set(r,'{resources}',public.resource_snapshot(%1$I)); END IF;
    IF r ? 'tutorial' THEN r:=jsonb_set(r,'{tutorial}',save.state->'tutorial'); END IF;
    IF r ? 'stock' THEN r:=jsonb_set(r,'{stock}',heroloop_api.premium_potion_status(%1$I)); END IF;
  END IF;
  RETURN r-'inventory_delivery';
END
$body$,spec.player_arg,fn.nspname,private_name,calls,replay_sql,receipt_sql);
    EXECUTE format('CREATE OR REPLACE FUNCTION %I.%I(%s) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS %L',
      fn.nspname,fn.proname,pg_get_function_arguments(fn.oid),body);
  END LOOP;
END
$wrappers$;
COMMIT;
