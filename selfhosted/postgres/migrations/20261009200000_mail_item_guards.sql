-- A ledger owner cannot bypass Mailbox capacity checks by saving, equipping,
-- selling, upgrading or listing an item which is still awaiting claim.
BEGIN;
CREATE FUNCTION public.item_waiting_in_mail(p_item uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.player_mail_items WHERE item_id=p_item AND claimed_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.player_mail_rewards WHERE kind='item' AND payload->>'item_id'=p_item::text AND claimed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.item_waiting_in_mail(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE d text; n text; signature text;
BEGIN
  d:=pg_get_functiondef('heroloop_api.game_state_save_context(uuid)'::regprocedure);
  n:=replace(d,'''active_escrow'',', '''active_mail'', public.item_waiting_in_mail(item.id), ''active_escrow'',');
  IF n=d THEN RAISE EXCEPTION 'mail_save_context_anchor_missing'; END IF;
  EXECUTE n;
  d:=pg_get_functiondef('heroloop_api.game_state_save_commit(uuid,bigint,jsonb)'::regprocedure);
  n:=replace(d,'  UPDATE public.player_saves',
    $new$  IF EXISTS(SELECT 1 FROM public.player_items item WHERE item.player_id=p_player_id AND public.item_waiting_in_mail(item.id)
      AND (EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'inventory','[]')) x WHERE x->>'uid'=item.id::text)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_state->'ownedHeroes','[]')) h,
          LATERAL jsonb_each_text(COALESCE(h->'equipped','{}')) e WHERE e.value=item.id::text))) THEN
    RAISE EXCEPTION 'item_in_mail';
  END IF;
  UPDATE public.player_saves$new$);
  IF n=d THEN RAISE EXCEPTION 'mail_save_commit_anchor_missing'; END IF;
  EXECUTE n;
  FOREACH signature IN ARRAY ARRAY[
    'public.settle_item_upgrade(uuid,uuid,text,uuid,boolean)',
    'public.seeker_settle_item_upgrade(uuid,uuid,text,uuid,boolean)',
    'public.settle_market_list(uuid,uuid,uuid,bigint)',
    'public.seeker_settle_market_list(uuid,uuid,uuid,bigint)'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    n:=replace(d,$old$  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;$old$,
      $new$  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF public.item_waiting_in_mail(p_item_id) THEN RAISE EXCEPTION 'item_in_mail'; END IF;$new$);
    IF n=d THEN RAISE EXCEPTION 'mail_item_guard_anchor_missing: %',signature; END IF;
    EXECUTE n;
  END LOOP;
  d:=pg_get_functiondef('public.settle_item_mutation(uuid,uuid,text,uuid[],boolean)'::regprocedure);
  n:=replace(d,'  SELECT count(*), COALESCE(bool_or(locked), false)',
    $new$  IF EXISTS(SELECT 1 FROM unnest(v_ids) id WHERE public.item_waiting_in_mail(id)) THEN RAISE EXCEPTION 'item_in_mail'; END IF;
  SELECT count(*), COALESCE(bool_or(locked), false)$new$);
  IF n=d THEN RAISE EXCEPTION 'mail_item_mutation_anchor_missing'; END IF;
  EXECUTE n;
  d:=pg_get_functiondef('public.settle_item_equipment_before_compact_receipt(uuid,uuid,jsonb)'::regprocedure);
  n:=replace(d,'    IF NOT v_hero_uid = ANY(v_team)',
    $new$    IF public.item_waiting_in_mail(v_item_uid) THEN RAISE EXCEPTION 'item_in_mail'; END IF;
    IF NOT v_hero_uid = ANY(v_team)$new$);
  IF n=d THEN RAISE EXCEPTION 'mail_item_equipment_anchor_missing'; END IF;
  EXECUTE n;
END
$patch$;
COMMIT;
