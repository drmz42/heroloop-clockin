ALTER FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  RENAME TO settle_item_upgrade_v2;

REVOKE ALL ON FUNCTION public.settle_item_upgrade_v2(uuid, uuid, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.settle_item_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_action_kind text,
  p_item_id uuid,
  p_use_charm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.item_upgrade_events%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_result jsonb;
  v_state jsonb;
  v_inventory jsonb;
  v_owned jsonb;
  v_next_owned jsonb;
BEGIN
  -- Historical replays retain the exact result recorded under the earlier rule.
  SELECT * INTO v_existing
  FROM public.item_upgrade_events
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN public.settle_item_upgrade_v2(
      p_player_id, p_idempotency_key, p_action_kind, p_item_id, p_use_charm
    );
  END IF;

  v_result := public.settle_item_upgrade_v2(
    p_player_id, p_idempotency_key, p_action_kind, p_item_id, p_use_charm
  );

  IF p_action_kind <> 'enchant'
    OR COALESCE((v_result->>'success')::boolean, false)
    OR p_use_charm
    OR COALESCE((v_result->>'destroyed')::boolean, false) THEN
    RETURN v_result;
  END IF;

  UPDATE public.player_items
  SET removed_at = now()
  WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL
  RETURNING * INTO v_item;

  -- A concurrent same-key replay can only observe the already-finalized event.
  IF NOT FOUND THEN
    SELECT result INTO v_result
    FROM public.item_upgrade_events
    WHERE idempotency_key = p_idempotency_key;
    RETURN v_result;
  END IF;

  SELECT state INTO v_state
  FROM public.player_saves
  WHERE player_id = p_player_id
  FOR UPDATE;

  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(entry.item ORDER BY entry.ordinality), '[]'::jsonb)
  INTO v_inventory
  FROM jsonb_array_elements(v_inventory) WITH ORDINALITY entry(item, ordinality)
  WHERE entry.item->>'uid' <> p_item_id::text;

  SELECT COALESCE(jsonb_agg(jsonb_set(hero.item, '{equipped}', COALESCE((
    SELECT jsonb_object_agg(pair.key, pair.value)
    FROM jsonb_each(COALESCE(hero.item->'equipped', '{}'::jsonb)) pair
    WHERE pair.value #>> '{}' <> p_item_id::text
  ), '{}'::jsonb), true) ORDER BY hero.ordinality), '[]'::jsonb)
  INTO v_next_owned
  FROM jsonb_array_elements(v_owned) WITH ORDINALITY hero(item, ordinality);
  v_owned := v_next_owned;

  IF v_item.rarity IN ('divine','celestial','cursed','immortal','god') THEN
    UPDATE public.rarity_supply
    SET existing_count = GREATEST(0, existing_count - 1), updated_at = now()
    WHERE rarity = v_item.rarity;
  END IF;

  v_state := jsonb_set(jsonb_set(v_state, '{inventory}', v_inventory, true),
    '{ownedHeroes}', v_owned, true);
  UPDATE public.player_saves
  SET state = v_state, updated_at = now()
  WHERE player_id = p_player_id;

  v_result := v_result || jsonb_build_object(
    'destroyed', true,
    'item', NULL,
    'inventory', v_inventory,
    'owned_heroes', v_owned
  );
  UPDATE public.item_upgrade_events
  SET result = v_result
  WHERE idempotency_key = p_idempotency_key;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_item_upgrade(uuid, uuid, text, uuid, boolean)
  TO service_role;
