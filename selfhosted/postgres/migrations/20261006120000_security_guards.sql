-- Security guards for the isolated Seeker backend.
BEGIN;

CREATE OR REPLACE FUNCTION heroloop_api.resolve_authenticated_account(p_auth_subject uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api
AS $function$
DECLARE
  v_account_id uuid;
  v_identity_state text;
  v_account_state text;
BEGIN
  IF p_auth_subject IS NULL THEN
    RETURN jsonb_build_object('authenticated', false);
  END IF;
  SELECT identity.account_id, identity.state, account.state
  INTO v_account_id, v_identity_state, v_account_state
  FROM heroloop_api.account_auth_subjects subject
  JOIN heroloop_api.account_identities identity USING (identity_id)
  JOIN heroloop_api.heroloop_accounts account USING (account_id)
  WHERE subject.auth_subject = p_auth_subject;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM heroloop_api.heroloop_accounts
      WHERE account_id = p_auth_subject AND state IS DISTINCT FROM 'active') THEN
      RETURN jsonb_build_object('authenticated', false);
    END IF;
    RETURN jsonb_build_object('authenticated', true, 'account_id', p_auth_subject);
  END IF;
  IF v_identity_state <> 'active' OR v_account_state <> 'active' THEN
    RETURN jsonb_build_object('authenticated', false);
  END IF;
  RETURN jsonb_build_object('authenticated', true, 'account_id', v_account_id);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.assert_wallet_withdrawal_allowed(p_player uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM public.assert_account_value_allowed(p_player);
 RETURN jsonb_build_object('allowed',true);
END $$;
REVOKE ALL ON FUNCTION heroloop_api.assert_wallet_withdrawal_allowed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.assert_wallet_withdrawal_allowed(uuid) TO heroloop_api;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('heroloop_api.game_state_save_context(uuid)'::regprocedure);
 IF position($marker$active_escrow$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$'id', item.id,$old$,$new$'id', item.id,
        'active_escrow', EXISTS (SELECT 1 FROM public.market_item_listings listing WHERE listing.item_id=item.id AND listing.status='active'),$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:heroloop_api.game_state_save_context(uuid)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('heroloop_api.game_state_save_commit(uuid,bigint,jsonb)'::regprocedure);
 IF position($marker$item_in_market_escrow$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$  UPDATE public.player_saves
  SET state = p_state$old$,$new$  -- Serialize with listing creation and item settlement before consulting escrow.
  PERFORM 1 FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
  PERFORM id FROM public.player_items WHERE player_id=p_player_id AND removed_at IS NULL ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.market_item_listings l WHERE l.seller_id=p_player_id AND l.status='active'
    AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'inventory','[]'::jsonb)) i WHERE i->>'uid'=l.item_id::text)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'ownedHeroes','[]'::jsonb)) h,
        LATERAL jsonb_each_text(COALESCE(h->'equipped','{}'::jsonb)) e WHERE e.value=l.item_id::text))) THEN
    RAISE EXCEPTION 'item_in_market_escrow';
  END IF;
  UPDATE public.player_saves
  SET state = p_state$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:heroloop_api.game_state_save_commit(uuid,bigint,jsonb)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('public.settle_item_mutation(uuid,uuid,text,uuid[],boolean)'::regprocedure);
 IF position($marker$item_in_market_escrow$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$  SELECT count(*), COALESCE(bool_or(locked), false)$old$,$new$  IF EXISTS (SELECT 1 FROM public.market_item_listings WHERE item_id=ANY(v_ids) AND status='active') THEN RAISE EXCEPTION 'item_in_market_escrow'; END IF;
  SELECT count(*), COALESCE(bool_or(locked), false)$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:public.settle_item_mutation(uuid,uuid,text,uuid[],boolean)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('public.settle_item_equipment_before_compact_receipt(uuid,uuid,jsonb)'::regprocedure);
 IF position($marker$item_in_market_escrow$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$    IF NOT v_hero_uid = ANY(v_team)$old$,$new$    IF EXISTS (SELECT 1 FROM public.market_item_listings WHERE item_id=v_item_uid AND status='active') THEN RAISE EXCEPTION 'item_in_market_escrow'; END IF;
    IF NOT v_hero_uid = ANY(v_team)$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:public.settle_item_equipment_before_compact_receipt(uuid,uuid,jsonb)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('public.settle_item_upgrade(uuid,uuid,text,uuid,boolean)'::regprocedure);
 IF position($marker$item_in_market_escrow$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;$old$,$new$  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.market_item_listings WHERE item_id=p_item_id AND status='active') THEN RAISE EXCEPTION 'item_in_market_escrow'; END IF;$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:public.settle_item_upgrade(uuid,uuid,text,uuid,boolean)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('public.seeker_settle_item_upgrade(uuid,uuid,text,uuid,boolean)'::regprocedure);
 IF position($marker$item_in_market_escrow$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;$old$,$new$  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.market_item_listings WHERE item_id=p_item_id AND status='active') THEN RAISE EXCEPTION 'item_in_market_escrow'; END IF;$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:public.seeker_settle_item_upgrade(uuid,uuid,text,uuid,boolean)'; END IF;
 EXECUTE n;
END $guard$;


-- Prepared requests reserve queue capacity, so concurrent quotes cannot oversubscribe it.
CREATE OR REPLACE FUNCTION public.assert_training_boost_capacity(p_player uuid,p_key uuid,p_boost text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb; camp jsonb; pending integer;
BEGIN
 SELECT state INTO s FROM public.player_saves WHERE player_id=p_player FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
 s:=public.settle_training_state_at(s,clock_timestamp(),LEAST(10,2+public.training_slot_purchase_count(p_player)));
 camp:=s->'trainingCamp';
 SELECT count(*) INTO pending FROM public.seeker_commerce_requests
 WHERE player_id=p_player AND action='training_boost_buy' AND status='prepared' AND id<>p_key;
 IF jsonb_array_length(COALESCE(camp->'boostQueue','[]'::jsonb))+pending>=100
   AND COALESCE((camp->>'boostMultiplier')::integer,1)>1
   AND (camp->>'boostEndsAt')::bigint>(camp->>'lastTick')::bigint
   AND camp->>'activeBoostKey' IS DISTINCT FROM p_boost THEN
  RAISE EXCEPTION 'training_boost_queue_full';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.assert_training_boost_capacity(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION heroloop_api.seeker_purchase_assert_payable(p_player uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.seeker_commerce_requests;
BEGIN
 SELECT * INTO r FROM public.seeker_commerce_requests WHERE id=p_key AND player_id=p_player;
 IF NOT FOUND THEN RAISE EXCEPTION 'skr_quote_not_found'; END IF;
 IF r.status='prepared' AND r.action='training_boost_buy' THEN
  PERFORM public.assert_training_boost_capacity(p_player,p_key,r.params->>'boost');
 END IF;
 RETURN jsonb_build_object('allowed',true);
END $$;
REVOKE ALL ON FUNCTION heroloop_api.seeker_purchase_assert_payable(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_purchase_assert_payable(uuid,uuid) TO heroloop_api;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
 IF position($marker$assert_training_boost_capacity$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$ ELSIF p_action='training_boost_buy' THEN$old$,$new$ ELSIF p_action='training_boost_buy' THEN
  PERFORM public.assert_training_boost_capacity(p_player,p_key,p_params->>'boost');$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
 IF position($marker$assert_training_boost_capacity$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$   IF r.action='training_boost_buy' THEN$old$,$new$   IF r.action='training_boost_buy' THEN
    PERFORM public.assert_training_boost_capacity(p_player,p_key,r.params->>'boost');$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:heroloop_api.seeker_purchase_deliver(uuid,uuid)'; END IF;
 EXECUTE n;
END $guard$;


-- Patch the installed definition, preserving subsequent rule extensions.
DO $guard$
DECLARE d text; n text;
BEGIN
 d:=pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
 IF position($marker$'training_boost_queue_full'$marker$ IN d)>0 THEN RETURN; END IF;
 n:=replace(d,$old$'market_listing_unavailable','market_self_purchase'$old$,$new$'training_boost_queue_full','item_in_market_escrow','market_listing_unavailable','market_self_purchase'$new$);
 IF n=d THEN RAISE EXCEPTION 'security_guard_patch_failed:heroloop_api.seeker_purchase_deliver(uuid,uuid)'; END IF;
 EXECUTE n;
END $guard$;

COMMIT;
