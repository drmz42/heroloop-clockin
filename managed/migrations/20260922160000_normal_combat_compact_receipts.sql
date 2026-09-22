-- Keep the client completion contract intact without persisting its full save
-- snapshot twice.  The old function still owns the atomic server settlement;
-- this outer receipt layer runs only after it has committed the authoritative
-- result in the current transaction.
ALTER FUNCTION public.normal_combat_complete(uuid, uuid, uuid)
  RENAME TO normal_combat_complete_before_compact_receipt;

REVOKE ALL ON FUNCTION public.normal_combat_complete_before_compact_receipt(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.normal_combat_complete(
  p_player_id uuid, p_start_key uuid, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_response jsonb;
  v_receipt jsonb;
  v_event public.normal_combat_events%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
BEGIN
  v_response := public.normal_combat_complete_before_compact_receipt(
    p_player_id, p_start_key, p_idempotency_key
  );

  SELECT result INTO v_receipt
  FROM public.normal_combat_completion_events
  WHERE idempotency_key = p_idempotency_key
    AND player_id = p_player_id
    AND start_key = p_start_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'normal_combat_receipt_missing';
  END IF;

  -- A receipt written by this migration deliberately has no player-save copy.
  -- A retry therefore returns the latest authoritative save and its matching
  -- revision, while the immutable wave/reward receipt proves what settled.
  IF v_receipt->>'rules_version' = 'normal-combat-receipt-v1' THEN
    SELECT * INTO v_save
    FROM public.player_saves
    WHERE player_id = p_player_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'save_not_found';
    END IF;

    RETURN jsonb_build_object(
      'wave_id', v_receipt->'wave_id',
      'start_key', v_receipt->'start_key',
      'revision', v_save.revision,
      'state', v_save.state,
      'outcome', jsonb_build_object('all_cleared', COALESCE(v_receipt->'all_cleared', 'false'::jsonb)),
      'rewards', v_receipt->'rewards',
      'auto_pot', jsonb_build_object(
        'gold_spent', COALESCE((v_receipt#>>'{flags,auto_pot_gold_spent}')::bigint, 0)
      ),
      'replayed', true
    );
  END IF;

  -- Pre-migration receipts retain their original complete response.  They are
  -- never rewritten here: a historical retry must remain exactly compatible.
  IF COALESCE((v_response->>'replayed')::boolean, false) THEN
    RETURN v_response;
  END IF;

  SELECT * INTO v_event
  FROM public.normal_combat_events
  WHERE start_key = p_start_key
    AND player_id = p_player_id;
  IF NOT FOUND OR v_event.completed_at IS NULL OR v_event.outcome IS NULL THEN
    RAISE EXCEPTION 'normal_combat_receipt_source_missing';
  END IF;

  v_receipt := jsonb_build_object(
    'rules_version', 'normal-combat-receipt-v1',
    'wave_id', v_event.id,
    'start_key', v_event.start_key,
    'revision', v_response->'revision',
    'balance_version', v_event.balance_version,
    'rewards', v_response->'rewards',
    'all_cleared', COALESCE(v_event.outcome->'all_cleared', 'false'::jsonb),
    'elapsed_ms', COALESCE(v_event.outcome->'elapsed_ms', '0'::jsonb),
    'outcome_hash', encode(extensions.digest(v_event.outcome::text, 'sha256'), 'hex'),
    'flags', jsonb_build_object(
      'auto_pot_gold_spent', COALESCE((v_response#>>'{auto_pot,gold_spent}')::bigint, 0)
    )
  );

  UPDATE public.normal_combat_events
  SET result = v_receipt
  WHERE start_key = p_start_key
    AND player_id = p_player_id;
  UPDATE public.normal_combat_completion_events
  SET result = v_receipt
  WHERE idempotency_key = p_idempotency_key
    AND player_id = p_player_id
    AND start_key = p_start_key;

  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.normal_combat_complete(uuid, uuid, uuid) IS
  'Returns the full authoritative completion response once; persists a compact, hash-bound receipt and rehydrates retries from player_saves.';
