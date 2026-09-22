DO $$
DECLARE
  v_restore record;
  v_state jsonb;
  v_inventory jsonb;
  v_heroes jsonb;
  v_new_id uuid;
  v_item jsonb;
BEGIN
  FOR v_restore IN
    WITH historical AS (
      SELECT DISTINCT ON (event.player_id, assignment->>'item_uid')
        event.player_id, assignment, event.created_at
      FROM public.item_equipment_events event
      CROSS JOIN LATERAL jsonb_array_elements(event.assignments) assignment
      ORDER BY event.player_id, assignment->>'item_uid', event.created_at DESC
    )
    SELECT historical.player_id, historical.assignment->>'hero_uid' AS hero_uid,
      historical.assignment->>'slot' AS target_slot, item.id AS original_item_id,
      item.base_item_id, item.slot AS item_slot, item.rarity, item.item_level, item.stats,
      item.power, item.locked, item.enchant_level, item.reroll_count, item.enchant_stats_version
    FROM historical
    JOIN public.player_items item ON item.id::text = historical.assignment->>'item_uid'
    WHERE (item.player_id <> historical.player_id OR item.removed_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM public.player_items restored
        WHERE restored.player_id = historical.player_id
          AND restored.source_kind = 'legacy_equipped_restore'
          AND restored.source_chest_id = item.id::text
      )
  LOOP
    SELECT state INTO v_state FROM public.player_saves WHERE player_id = v_restore.player_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero WHERE hero->>'uid' = v_restore.hero_uid) THEN
      CONTINUE;
    END IF;
    v_new_id := gen_random_uuid();
    INSERT INTO public.player_items (
      id, player_id, base_item_id, slot, rarity, item_level, stats, power, locked,
      enchant_level, reroll_count, enchant_stats_version, source_kind, source_chest_id
    ) VALUES (
      v_new_id, v_restore.player_id, v_restore.base_item_id, v_restore.item_slot, v_restore.rarity,
      v_restore.item_level, v_restore.stats, v_restore.power, v_restore.locked,
      v_restore.enchant_level, v_restore.reroll_count, v_restore.enchant_stats_version,
      'legacy_equipped_restore', v_restore.original_item_id::text
    );
    v_item := jsonb_build_object(
      'uid', v_new_id::text, 'itemId', v_restore.base_item_id, 'level', v_restore.item_level,
      'stats', v_restore.stats, 'power', v_restore.power, 'serverOwned', true, 'locked', v_restore.locked,
      'enchantLevel', v_restore.enchant_level, 'rerollCount', v_restore.reroll_count,
      'enchantStatsVersion', v_restore.enchant_stats_version
    );
    v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb) || jsonb_build_array(v_item);
    SELECT jsonb_agg(CASE WHEN hero->>'uid' = v_restore.hero_uid
      THEN jsonb_set(hero, ARRAY['equipped', v_restore.target_slot], to_jsonb(v_new_id::text), true)
      ELSE hero END)
    INTO v_heroes FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero;
    v_state := jsonb_set(jsonb_set(v_state, '{inventory}', v_inventory, true), '{ownedHeroes}', v_heroes, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = v_restore.player_id;
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
