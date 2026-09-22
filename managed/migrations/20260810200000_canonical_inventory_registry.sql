CREATE TABLE IF NOT EXISTS public.item_registry_migration_backups (
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  migration_key text NOT NULL,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, migration_key)
);

ALTER TABLE public.item_registry_migration_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.item_registry_migration_backups FROM PUBLIC, anon, authenticated;

INSERT INTO public.item_registry_migration_backups (player_id, migration_key, state, revision)
SELECT player_id, '20260810200000_canonical_inventory_registry', state, revision
FROM public.player_saves
ON CONFLICT (player_id, migration_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.migrate_legacy_player_items(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state jsonb;
  v_revision bigint;
  v_inventory jsonb := '[]'::jsonb;
  v_heroes jsonb;
  v_id_map jsonb := '{}'::jsonb;
  v_item jsonb;
  v_row public.player_items%ROWTYPE;
  v_old_id text;
  v_candidate_id uuid;
  v_new_id uuid;
  v_base_item_id text;
  v_slot text;
  v_rarity text;
  v_stats jsonb;
  v_migrated integer := 0;
  v_seen_ids text[] := ARRAY[]::text[];
BEGIN
  SELECT state, revision INTO v_state, v_revision
  FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) LOOP
    v_old_id := COALESCE(v_item->>'uid', '');
    v_row := NULL;
    BEGIN
      v_candidate_id := v_old_id::uuid;
      SELECT * INTO v_row FROM public.player_items
      WHERE id = v_candidate_id AND player_id = p_player_id AND removed_at IS NULL
        AND NOT v_candidate_id::text = ANY(v_seen_ids);
    EXCEPTION WHEN invalid_text_representation THEN
      v_candidate_id := NULL;
    END;

    IF v_row.id IS NULL THEN
      v_base_item_id := COALESCE(v_item->>'itemId', '');
      v_rarity := substring(v_base_item_id FROM '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial|cursed|immortal|god)$');
      v_slot := CASE
        WHEN v_base_item_id LIKE 'weapon-%' THEN 'class_weapon'
        WHEN v_base_item_id LIKE 'offhand-%' THEN 'offhand'
        WHEN v_base_item_id LIKE 'armor-%' THEN 'chest'
        WHEN v_base_item_id LIKE 'helmet-%' THEN 'helmet'
        WHEN v_base_item_id LIKE 'gloves-%' THEN 'gloves'
        WHEN v_base_item_id LIKE 'boots-%' THEN 'boots'
        WHEN v_base_item_id LIKE 'ring-%' THEN 'ring'
        WHEN v_base_item_id LIKE 'amulet-%' THEN 'amulet'
        ELSE NULL
      END;
      IF v_base_item_id = '' OR v_rarity IS NULL OR v_slot IS NULL THEN
        RAISE EXCEPTION 'invalid_legacy_item';
      END IF;
      v_stats := CASE WHEN jsonb_typeof(v_item->'stats') = 'array' THEN v_item->'stats' ELSE '[]'::jsonb END;
      IF v_candidate_id IS NULL OR EXISTS (SELECT 1 FROM public.player_items WHERE id = v_candidate_id) THEN
        v_new_id := gen_random_uuid();
      ELSE
        v_new_id := v_candidate_id;
      END IF;
      INSERT INTO public.player_items (
        id, player_id, base_item_id, slot, rarity, item_level, stats, power, locked,
        enchant_level, reroll_count, enchant_stats_version, source_kind
      ) VALUES (
        v_new_id, p_player_id, v_base_item_id, v_slot, v_rarity,
        GREATEST(1, COALESCE((v_item->>'level')::integer, 1)), v_stats,
        GREATEST(0, COALESCE((v_item->>'power')::bigint, 0)), COALESCE((v_item->>'locked')::boolean, false),
        GREATEST(0, COALESCE((v_item->>'enchantLevel')::integer, 0)),
        GREATEST(0, COALESCE((v_item->>'rerollCount')::integer, 0)),
        GREATEST(1, COALESCE((v_item->>'enchantStatsVersion')::integer, 2)), 'legacy_migration'
      ) RETURNING * INTO v_row;
      v_migrated := v_migrated + 1;
    ELSE
      v_new_id := v_row.id;
    END IF;

    IF v_old_id <> '' AND v_old_id <> v_new_id::text THEN
      v_id_map := v_id_map || jsonb_build_object(v_old_id, v_new_id::text);
    END IF;
    v_inventory := v_inventory || jsonb_build_array(v_item || jsonb_build_object(
      'uid', v_new_id::text, 'itemId', v_row.base_item_id, 'level', v_row.item_level,
      'stats', v_row.stats, 'power', v_row.power, 'serverOwned', true, 'locked', v_row.locked,
      'enchantLevel', v_row.enchant_level, 'rerollCount', v_row.reroll_count,
      'enchantStatsVersion', v_row.enchant_stats_version
    ));
    v_seen_ids := array_append(v_seen_ids, v_new_id::text);
  END LOOP;

  SELECT COALESCE(jsonb_agg(hero.value || jsonb_build_object('equipped', COALESCE((
    SELECT jsonb_object_agg(pair.key, to_jsonb(COALESCE(v_id_map->>(pair.value#>>'{}'), pair.value#>>'{}')))
    FROM jsonb_each(COALESCE(hero.value->'equipped', '{}'::jsonb)) pair
  ), '{}'::jsonb)) ORDER BY hero.ordinality), '[]'::jsonb)
  INTO v_heroes
  FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) WITH ORDINALITY hero(value, ordinality);

  IF v_migrated > 0 OR v_id_map <> '{}'::jsonb THEN
    v_state := jsonb_set(jsonb_set(v_state, '{inventory}', v_inventory, true), '{ownedHeroes}', v_heroes, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  END IF;
  RETURN jsonb_build_object('state', v_state, 'revision', v_revision, 'migrated_items', v_migrated);
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_legacy_player_items(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_legacy_player_items(uuid) TO service_role;

DO $$
DECLARE v_player record;
BEGIN
  FOR v_player IN SELECT player_id FROM public.player_saves LOOP
    PERFORM public.migrate_legacy_player_items(v_player.player_id);
  END LOOP;
END;
$$;

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
    WITH latest AS (
      SELECT DISTINCT ON (player_id) player_id, assignments
      FROM public.item_equipment_events ORDER BY player_id, created_at DESC
    )
    SELECT latest.player_id, assignment->>'hero_uid' AS hero_uid, assignment->>'slot' AS target_slot,
      item.id AS original_item_id, item.base_item_id, item.slot AS item_slot, item.rarity,
      item.item_level, item.stats, item.power, item.locked, item.enchant_level,
      item.reroll_count, item.enchant_stats_version
    FROM latest
    CROSS JOIN LATERAL jsonb_array_elements(latest.assignments) assignment
    JOIN public.market_item_listings listing
      ON listing.seller_id = latest.player_id
     AND listing.item_id::text = assignment->>'item_uid'
     AND listing.status = 'sold'
    JOIN public.player_items item ON item.id = listing.item_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.player_items restored
      WHERE restored.player_id = latest.player_id
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
