-- Mailbox claim receipts keep counts and revision only (storage passport:
-- no full bag in the permanent receipt); a replay returns the current bag.
-- Receipts written before this migration still carry the bag; replay drops it.

CREATE OR REPLACE FUNCTION heroloop_api.mail_claim(p_player_id uuid, p_idempotency_key uuid, p_mail_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request jsonb := jsonb_build_object('mail_id', p_mail_id);
  v_existing public.player_mail_claim_events%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_revision bigint;
  v_free integer;
  v_mail public.player_mail_items%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_claimed integer := 0;
  v_changed boolean := false;
  v_remaining integer;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.player_mail_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    -- The receipt keeps counts only; a replay returns the current canonical bag.
    RETURN (v_existing.result - 'inventory') || COALESCE((
      SELECT jsonb_build_object('inventory', COALESCE(state->'inventory', '[]'::jsonb)) FROM public.player_saves WHERE player_id = p_player_id
    ), '{}'::jsonb);
  END IF;

  SELECT state, revision INTO v_state, v_revision FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_free := 64 - public.server_market_bag_count(v_state);

  IF p_mail_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.player_mail_items WHERE id = p_mail_id AND player_id = p_player_id AND claimed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'mail_not_found';
  END IF;

  FOR v_mail IN
    SELECT * FROM public.player_mail_items
    WHERE player_id = p_player_id AND claimed_at IS NULL AND (p_mail_id IS NULL OR id = p_mail_id)
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    SELECT * INTO v_item FROM public.player_items
      WHERE id = v_mail.item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'unavailable' WHERE id = v_mail.id;
      CONTINUE;
    END IF;
    -- A save that already carries this uid must not get a second copy.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory) entry WHERE entry->>'uid' = v_item.id::text) THEN
      UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'already_in_bag' WHERE id = v_mail.id;
      CONTINUE;
    END IF;
    IF v_free <= 0 THEN
      IF p_mail_id IS NOT NULL OR v_claimed = 0 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;
      EXIT;
    END IF;
    v_inventory := v_inventory || jsonb_build_array(public.mail_item_json(v_item));
    UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'claimed' WHERE id = v_mail.id;
    v_free := v_free - 1;
    v_claimed := v_claimed + 1;
    v_changed := true;
  END LOOP;

  IF v_changed THEN
    v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  END IF;
  SELECT count(*) INTO v_remaining FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL;
  v_result := jsonb_build_object('claimed', v_claimed, 'remaining', v_remaining, 'revision', v_revision);
  INSERT INTO public.player_mail_claim_events(idempotency_key, player_id, request, result)
    VALUES (p_idempotency_key, p_player_id, v_request, v_result);
  RETURN v_result || jsonb_build_object('inventory', v_inventory);
END
$function$;


UPDATE public.player_mail_claim_events SET result = result - 'inventory' WHERE result ? 'inventory';

REVOKE ALL ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) TO heroloop_api;
