CREATE TABLE IF NOT EXISTS public.item_mutation_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  action_kind text NOT NULL CHECK (action_kind IN ('lock', 'sell')),
  item_ids uuid[] NOT NULL,
  desired_locked boolean,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.item_mutation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.item_mutation_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_item_mutation(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_action_kind text,
  p_item_ids uuid[],
  p_desired_locked boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.item_mutation_events%ROWTYPE;
  v_ids uuid[];
  v_id_texts text[];
  v_state jsonb;
  v_inventory jsonb;
  v_new_inventory jsonb := '[]'::jsonb;
  v_heroes jsonb := '[]'::jsonb;
  v_item jsonb;
  v_hero jsonb;
  v_equipped jsonb;
  v_pair record;
  v_found integer := 0;
  v_row_count integer;
  v_any_locked boolean;
  v_refund bigint := 0;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_action_kind NOT IN ('lock', 'sell') THEN RAISE EXCEPTION 'invalid_item_action'; END IF;
  SELECT array_agg(DISTINCT item_id ORDER BY item_id) INTO v_ids FROM unnest(p_item_ids) AS supplied(item_id);
  IF COALESCE(cardinality(v_ids), 0) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'invalid_item_count'; END IF;
  IF p_action_kind = 'lock' AND (cardinality(v_ids) <> 1 OR p_desired_locked IS NULL) THEN
    RAISE EXCEPTION 'invalid_lock_request';
  END IF;
  SELECT array_agg(id::text ORDER BY id) INTO v_id_texts FROM unnest(v_ids) AS selected(id);

  SELECT * INTO v_existing FROM public.item_mutation_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action_kind <> p_action_kind
      OR v_existing.item_ids <> v_ids OR v_existing.desired_locked IS DISTINCT FROM p_desired_locked THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  PERFORM id FROM public.player_items
    WHERE player_id = p_player_id AND id = ANY(v_ids) AND removed_at IS NULL
    ORDER BY id FOR UPDATE;
  SELECT count(*), COALESCE(bool_or(locked), false), COALESCE(sum(
    GREATEST(5, round(
      (CASE rarity
        WHEN 'common' THEN 0.3 WHEN 'uncommon' THEN 0.7 WHEN 'rare' THEN 1.4 WHEN 'epic' THEN 2.8
        WHEN 'legendary' THEN 4.6 WHEN 'mythic' THEN 6.5 WHEN 'relic' THEN 6.5 WHEN 'cosmic' THEN 9
        WHEN 'divine' THEN 13 WHEN 'celestial' THEN 18 ELSE 0
      END) * 5 * (1 + (item_level - 1) * 0.05) * (1 + enchant_level * 0.2)
    ))
  ), 0)::bigint
  INTO v_row_count, v_any_locked, v_refund
  FROM public.player_items
  WHERE player_id = p_player_id AND id = ANY(v_ids) AND removed_at IS NULL;
  IF v_row_count <> cardinality(v_ids) THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF p_action_kind = 'sell' AND v_any_locked THEN RAISE EXCEPTION 'item_locked'; END IF;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_inventory) LOOP
    IF COALESCE(v_item->>'uid', '') = ANY(v_id_texts) THEN
      v_found := v_found + 1;
      IF p_action_kind = 'lock' THEN
        v_new_inventory := v_new_inventory || jsonb_build_array(v_item || jsonb_build_object('locked', p_desired_locked));
      END IF;
    ELSE
      v_new_inventory := v_new_inventory || jsonb_build_array(v_item);
    END IF;
  END LOOP;
  IF v_found <> cardinality(v_ids) THEN RAISE EXCEPTION 'item_state_mismatch'; END IF;

  IF p_action_kind = 'lock' THEN
    UPDATE public.player_items SET locked = p_desired_locked WHERE player_id = p_player_id AND id = v_ids[1];
  ELSE
    FOR v_hero IN SELECT value FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) LOOP
      v_equipped := '{}'::jsonb;
      FOR v_pair IN SELECT key, value FROM jsonb_each(COALESCE(v_hero->'equipped', '{}'::jsonb)) LOOP
        IF NOT COALESCE(v_pair.value#>>'{}', '') = ANY(v_id_texts) THEN
          v_equipped := v_equipped || jsonb_build_object(v_pair.key, v_pair.value);
        END IF;
      END LOOP;
      v_heroes := v_heroes || jsonb_build_array(jsonb_set(v_hero, '{equipped}', v_equipped, true));
    END LOOP;
    v_state := jsonb_set(v_state, '{ownedHeroes}', v_heroes, true);
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_refund), true);
    UPDATE public.player_items SET removed_at = now() WHERE player_id = p_player_id AND id = ANY(v_ids);
    UPDATE public.rarity_supply supply SET
      existing_count = GREATEST(0, supply.existing_count - sold.count), updated_at = now()
    FROM (
      SELECT rarity, count(*)::integer AS count FROM public.player_items
      WHERE player_id = p_player_id AND id = ANY(v_ids) GROUP BY rarity
    ) sold
    WHERE supply.rarity = sold.rarity AND supply.rarity IN ('divine', 'celestial');
  END IF;

  v_state := jsonb_set(v_state, '{inventory}', v_new_inventory, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  v_result := jsonb_build_object(
    'item_ids', to_jsonb(v_ids), 'action_kind', p_action_kind, 'locked', p_desired_locked,
    'gold_refund', CASE WHEN p_action_kind = 'sell' THEN v_refund ELSE 0 END, 'revision', v_revision
  );
  INSERT INTO public.item_mutation_events (idempotency_key, player_id, action_kind, item_ids, desired_locked, result)
    VALUES (p_idempotency_key, p_player_id, p_action_kind, v_ids, p_desired_locked, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_item_mutation(uuid, uuid, text, uuid[], boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_item_mutation(uuid, uuid, text, uuid[], boolean) TO service_role;
