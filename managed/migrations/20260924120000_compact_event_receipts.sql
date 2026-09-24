-- New settlements keep only immutable evidence. Historical rows remain intact.
-- A retry of a compact receipt uses the current authoritative save, as normal
-- combat does; the original response is returned unchanged on first settlement.
ALTER FUNCTION public.settle_quest_claim(uuid,uuid,text,bigint)
  RENAME TO settle_quest_claim_before_compact_receipt;
ALTER FUNCTION public.settle_item_equipment(uuid,uuid,jsonb)
  RENAME TO settle_item_equipment_before_compact_receipt;
ALTER FUNCTION public.settle_hero_ascension(uuid,uuid,text,boolean)
  RENAME TO settle_hero_ascension_before_compact_receipt;

REVOKE ALL ON FUNCTION public.settle_quest_claim_before_compact_receipt(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.settle_item_equipment_before_compact_receipt(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.settle_hero_ascension_before_compact_receipt(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.settle_quest_claim(p_player_id uuid,p_idempotency_key uuid,p_quest_id text,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
DECLARE v_response jsonb; v_receipt jsonb; v_save public.player_saves%ROWTYPE;
BEGIN
  v_response := public.settle_quest_claim_before_compact_receipt(p_player_id,p_idempotency_key,p_quest_id,p_expected_revision);
  SELECT result INTO v_receipt FROM public.quest_claim_events
    WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id AND quest_id=p_quest_id AND expected_revision=p_expected_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'quest_receipt_missing'; END IF;
  IF v_receipt->>'rules_version' = 'quest-compact-receipt-v1' THEN
    SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
    RETURN (v_receipt - 'rules_version' - 'state_hash') ||
      jsonb_build_object('state',v_save.state,'revision',v_save.revision,'replayed',true);
  END IF;
  IF COALESCE((v_response->>'replayed')::boolean,false) THEN RETURN v_response; END IF;
  v_receipt := (v_response - 'state') || jsonb_build_object(
    'rules_version','quest-compact-receipt-v1',
    'state_hash',encode(extensions.digest((v_response->'state')::text,'sha256'),'hex'));
  UPDATE public.quest_claim_events SET result=v_receipt WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id;
  RETURN v_response;
END $$;

CREATE FUNCTION public.settle_item_equipment(p_player_id uuid,p_idempotency_key uuid,p_assignments jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
DECLARE v_response jsonb; v_receipt jsonb; v_save public.player_saves%ROWTYPE;
BEGIN
  v_response := public.settle_item_equipment_before_compact_receipt(p_player_id,p_idempotency_key,p_assignments);
  SELECT result INTO v_receipt FROM public.item_equipment_events
    WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id AND assignments=p_assignments;
  IF NOT FOUND THEN RAISE EXCEPTION 'equipment_receipt_missing'; END IF;
  IF v_receipt->>'rules_version' = 'equipment-compact-receipt-v1' THEN
    SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
    RETURN (v_receipt - 'rules_version' - 'owned_heroes_hash') ||
      jsonb_build_object('owned_heroes',v_save.state->'ownedHeroes','revision',v_save.revision);
  END IF;
  -- The legacy function does not mark replays, so the persisted receipt is
  -- compared to the returned value before replacing a newly written row.
  IF v_receipt <> v_response THEN RETURN v_response; END IF;
  v_receipt := (v_response - 'owned_heroes') || jsonb_build_object(
    'rules_version','equipment-compact-receipt-v1',
    'owned_heroes_hash',encode(extensions.digest((v_response->'owned_heroes')::text,'sha256'),'hex'));
  UPDATE public.item_equipment_events SET result=v_receipt WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id;
  RETURN v_response;
END $$;

CREATE FUNCTION public.settle_hero_ascension(p_player_id uuid,p_idempotency_key uuid,p_target_uid text,p_repeat boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
DECLARE v_response jsonb; v_receipt jsonb; v_save public.player_saves%ROWTYPE;
BEGIN
  v_response := public.settle_hero_ascension_before_compact_receipt(p_player_id,p_idempotency_key,p_target_uid,p_repeat);
  SELECT result INTO v_receipt FROM public.hero_ascension_events
    WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id AND target_uid=p_target_uid AND repeat_upgrades=p_repeat;
  IF NOT FOUND THEN RAISE EXCEPTION 'ascension_receipt_missing'; END IF;
  IF v_receipt->>'rules_version' = 'ascension-compact-receipt-v1' THEN
    SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
    RETURN (v_receipt - 'rules_version' - 'owned_heroes_hash') ||
      jsonb_build_object('owned_heroes',v_save.state->'ownedHeroes','revision',v_save.revision);
  END IF;
  IF v_receipt <> v_response THEN RETURN v_response; END IF;
  v_receipt := (v_response - 'owned_heroes') || jsonb_build_object(
    'rules_version','ascension-compact-receipt-v1',
    'owned_heroes_hash',encode(extensions.digest((v_response->'owned_heroes')::text,'sha256'),'hex'));
  UPDATE public.hero_ascension_events SET result=v_receipt WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id;
  RETURN v_response;
END $$;

REVOKE ALL ON FUNCTION public.settle_quest_claim(uuid,uuid,text,bigint),
  public.settle_item_equipment(uuid,uuid,jsonb),
  public.settle_hero_ascension(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.settle_quest_claim(uuid,uuid,text,bigint),
  public.settle_item_equipment(uuid,uuid,jsonb),
  public.settle_hero_ascension(uuid,uuid,text,boolean) TO service_role;

-- Summon results contain rolled hero identities required by historical retry.
-- LZ4 reduces their physical TOAST footprint while retaining exact JSON and
-- changing no existing rows. PostgreSQL compresses new out-of-line values.
ALTER TABLE public.summon_events ALTER COLUMN result SET COMPRESSION lz4;
