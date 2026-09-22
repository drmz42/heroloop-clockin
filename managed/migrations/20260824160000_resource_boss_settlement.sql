CREATE OR REPLACE FUNCTION public.summon_boss(p_player_id uuid, p_location integer, p_idempotency_key uuid)
RETURNS TABLE(encounter_id uuid, remaining_keys integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_encounter uuid;
  v_keys integer;
  v_save public.player_saves%ROWTYPE;
  v_resource jsonb;
  v_existing public.resource_transactions%ROWTYPE;
  v_hash text := encode(extensions.digest(jsonb_build_object('location', GREATEST(1, p_location))::text, 'sha256'), 'hex');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  SELECT * INTO v_existing FROM public.resource_transactions
  WHERE player_id = p_player_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.action <> 'boss_summon' OR v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'resource_idempotency_conflict';
    END IF;
    RETURN QUERY SELECT (v_existing.result->>'encounter_id')::uuid, (v_existing.result->>'remaining_keys')::integer;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.dungeon_encounters WHERE player_id = p_player_id AND status = 'active')
    OR EXISTS (SELECT 1 FROM public.boss_encounters WHERE player_id = p_player_id AND status = 'active') THEN
    RAISE EXCEPTION 'active_encounter_exists';
  END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_resource := public.apply_resource_entries(p_player_id, p_idempotency_key, 'boss_summon', v_hash,
    '[{"resource_id":"boss_key","delta":"-1","source_key":"boss_key_spend"}]'::jsonb, v_save.revision + 1);
  v_keys := (v_resource#>>'{balances,boss_key}')::integer;
  INSERT INTO public.boss_encounters(player_id, location_id)
  VALUES (p_player_id, GREATEST(1, p_location)) RETURNING id INTO v_encounter;
  UPDATE public.players SET boss_keys = v_keys, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = jsonb_set(state, '{bossKeys}', to_jsonb(v_keys), true),
    revision = revision + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.resource_transactions SET result = result || jsonb_build_object('encounter_id', v_encounter, 'remaining_keys', v_keys)
  WHERE player_id = p_player_id AND idempotency_key = p_idempotency_key;
  RETURN QUERY SELECT v_encounter, v_keys;
END;
$$;

REVOKE ALL ON FUNCTION public.summon_boss(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.summon_boss(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.summon_boss(uuid, integer, uuid) TO service_role;
