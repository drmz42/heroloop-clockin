DO $$
DECLARE
  v_player record;
  v_state jsonb;
  v_equipped_ids text[];
  v_remove_ids text[];
  v_inventory jsonb;
BEGIN
  FOR v_player IN
    SELECT DISTINCT player_id FROM public.player_items
    WHERE source_kind = 'legacy_equipped_restore' AND removed_at IS NULL
  LOOP
    SELECT state INTO v_state FROM public.player_saves WHERE player_id = v_player.player_id FOR UPDATE;
    SELECT COALESCE(array_agg(DISTINCT pair.value#>>'{}'), ARRAY[]::text[])
    INTO v_equipped_ids
    FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero
    CROSS JOIN LATERAL jsonb_each(COALESCE(hero->'equipped', '{}'::jsonb)) pair;

    SELECT COALESCE(array_agg(id::text), ARRAY[]::text[])
    INTO v_remove_ids
    FROM public.player_items
    WHERE player_id = v_player.player_id
      AND source_kind = 'legacy_equipped_restore'
      AND removed_at IS NULL
      AND NOT id::text = ANY(v_equipped_ids);

    IF cardinality(v_remove_ids) > 0 THEN
      SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
      INTO v_inventory
      FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) WITH ORDINALITY item(value, ordinality)
      WHERE NOT COALESCE(item.value->>'uid', '') = ANY(v_remove_ids);
      UPDATE public.player_items SET removed_at = now()
      WHERE player_id = v_player.player_id AND id::text = ANY(v_remove_ids);
      v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
      UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = v_player.player_id;
    END IF;
  END LOOP;
END;
$$;

UPDATE public.rarity_supply supply
SET existing_count = LEAST(supply.max_existing, inventory.count), updated_at = now()
FROM (
  SELECT rarity, count(*)::integer AS count FROM public.player_items
  WHERE removed_at IS NULL AND rarity IN ('divine', 'celestial') GROUP BY rarity
) inventory
WHERE supply.rarity = inventory.rarity;
