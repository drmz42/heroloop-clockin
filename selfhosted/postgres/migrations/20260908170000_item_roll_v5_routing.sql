-- Route active item mutation/creation sources through the generated Item-roll v5
-- primitives. Existing stat rolls, ownership, listings and enchant levels remain
-- unchanged; the new marker records which base-roll model produced the stats.

ALTER TABLE public.player_items
  ADD COLUMN IF NOT EXISTS item_roll_version integer;

UPDATE public.player_items
SET item_roll_version = CASE
  WHEN enchant_stats_version IN (2, 3, 4) THEN enchant_stats_version
  ELSE 2
END
WHERE item_roll_version IS NULL;

ALTER TABLE public.player_items
  ALTER COLUMN item_roll_version SET DEFAULT 4,
  ALTER COLUMN item_roll_version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.player_items'::regclass
      AND conname = 'player_items_item_roll_version_check'
  ) THEN
    ALTER TABLE public.player_items
      ADD CONSTRAINT player_items_item_roll_version_check
      CHECK (item_roll_version IN (2, 3, 4, 5));
  END IF;
END;
$$;

-- Add the compatibility marker to persisted save snapshots without touching any
-- item value. Canonical load/save still reads the ledger as authority.
UPDATE public.player_saves save
SET state = jsonb_set(save.state, '{inventory}', COALESCE((
      SELECT jsonb_agg(
        CASE WHEN item.id IS NULL THEN entry.value ELSE entry.value || jsonb_build_object(
          'itemRollVersion', item.item_roll_version,
          'serverOwned', true
        ) END
        ORDER BY entry.ordinality
      )
      FROM jsonb_array_elements(COALESCE(save.state->'inventory', '[]'::jsonb))
        WITH ORDINALITY entry(value, ordinality)
      LEFT JOIN public.player_items item
        ON item.id::text = entry.value->>'uid'
       AND item.player_id = save.player_id
       AND item.removed_at IS NULL
    ), '[]'::jsonb), true),
    revision = save.revision + 1,
    updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM public.player_items item
  WHERE item.player_id = save.player_id AND item.removed_at IS NULL
);

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('public.settle_chest_open(uuid,uuid,integer)'::regprocedure);
  v_new := replace(v_def,
    'v_item_level := GREATEST(1, v_level + floor(random() * 5)::integer - 2);',
    'v_item_level := LEAST(99, GREATEST(1, v_level + floor(random() * 5)::integer - 2));');
  v_new := replace(v_new,
    'v_stats := public.roll_item_stats_v3(v_slot, v_rarity, v_item_level, v_base_item_id);',
    'v_stats := public.roll_item_stats_v5(v_slot, v_rarity, v_item_level, v_base_item_id);');
  v_new := replace(v_new,
    'v_power := public.calculate_item_power_v3(v_stats, 0);',
    'v_power := public.calculate_item_power_v5(v_stats, 0);');
  v_new := replace(v_new,
    $find$'enchantStatsVersion', 3,$find$,
    $find$'enchantStatsVersion', 4,
      'itemRollVersion', 5,$find$);
  v_new := replace(v_new,
    'reroll_count, enchant_stats_version, source_kind, source_chest_id',
    'reroll_count, enchant_stats_version, item_roll_version, source_kind, source_chest_id');
  v_new := replace(v_new,
    $find$v_rarity IN ('divine','celestial'), 0, 3, CASE$find$,
    $find$v_rarity IN ('divine','celestial'), 0, 4, 5, CASE$find$);
  IF v_new = v_def OR v_new NOT LIKE '%roll_item_stats_v5%' OR v_new NOT LIKE '%item_roll_version%' THEN
    RAISE EXCEPTION 'item_roll_v5_chest_patch_failed';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_store_purchase(uuid,uuid,integer,bigint)'::regprocedure);
  v_new := replace(v_def,
    'v_stats := public.roll_item_stats_v3(v_slot, v_rarity, 1, v_base_item_id);',
    'v_stats := public.roll_item_stats_v5(v_slot, v_rarity, 1, v_base_item_id);');
  v_new := replace(v_new,
    'v_power := public.calculate_item_power_v3(v_stats, 0);',
    'v_power := public.calculate_item_power_v5(v_stats, 0);');
  v_new := replace(v_new,
    $find$'enchantStatsVersion', 3, 'rerollCount'$find$,
    $find$'enchantStatsVersion', 4, 'itemRollVersion', 5, 'rerollCount'$find$);
  v_new := replace(v_new,
    'reroll_count, enchant_stats_version, source_kind)',
    'reroll_count, enchant_stats_version, item_roll_version, source_kind)');
  v_new := replace(v_new,
    $find$v_stats, v_power, false, 0, 3, 'store'$find$,
    $find$v_stats, v_power, false, 0, 4, 5, 'store'$find$);
  IF v_new = v_def OR v_new NOT LIKE '%roll_item_stats_v5%' OR v_new NOT LIKE '%item_roll_version%' THEN
    RAISE EXCEPTION 'item_roll_v5_store_patch_failed';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.settle_item_upgrade(uuid,uuid,text,uuid,boolean)'::regprocedure);
  v_new := replace(v_def,
    $find$'enchantStatsVersion', 4,
    'serverOwned', true$find$,
    $find$'enchantStatsVersion', 4,
    'itemRollVersion', v_item.item_roll_version,
    'serverOwned', true$find$);
  v_new := replace(v_new,
    'v_stats := public.roll_item_stats_v3(v_item.slot, v_item.rarity, v_item.item_level, v_item.base_item_id);',
    'v_stats := public.roll_item_stats_v5(v_item.slot, v_item.rarity, v_item.item_level, v_item.base_item_id);');
  v_new := replace(v_new,
    'v_new_power := public.calculate_item_power_v4(v_stats, v_item.enchant_level);',
    'v_new_power := public.calculate_item_power_v5(v_stats, v_item.enchant_level);');
  v_new := replace(v_new,
    $find$reroll_count = v_new_reroll,
        enchant_stats_version = 4$find$,
    $find$reroll_count = v_new_reroll,
        enchant_stats_version = 4,
        item_roll_version = 5$find$);
  v_new := replace(v_new,
    'v_item_json := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_item_json,',
    'v_item_json := jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_item_json,');
  v_new := replace(v_new,
    $find$'{rerollCount}', to_jsonb(v_new_reroll), true), '{enchantStatsVersion}', '4'::jsonb, true);$find$,
    $find$'{rerollCount}', to_jsonb(v_new_reroll), true), '{enchantStatsVersion}', '4'::jsonb, true),
      '{itemRollVersion}', '5'::jsonb, true);$find$);
  IF v_new = v_def OR v_new NOT LIKE '%roll_item_stats_v5%' OR v_new NOT LIKE '%item_roll_version = 5%' THEN
    RAISE EXCEPTION 'item_roll_v5_upgrade_patch_failed';
  END IF;
  EXECUTE v_new;
END;
$$;

CREATE OR REPLACE FUNCTION public.market_item_json(p_item public.player_items)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'uid', p_item.id::text,
    'itemId', p_item.base_item_id,
    'level', p_item.item_level,
    'enchantLevel', p_item.enchant_level,
    'enchantStatsVersion', p_item.enchant_stats_version,
    'itemRollVersion', p_item.item_roll_version,
    'rerollCount', p_item.reroll_count,
    'stats', p_item.stats,
    'power', p_item.power,
    'locked', p_item.locked,
    'isNew', false,
    'serverOwned', true
  )
$$;

-- The self-hosted API reads these registered contexts rather than querying the
-- ledger directly. Patch both projections and fail closed if their known shape
-- ever changes.
DO $$
DECLARE
  v_signature text;
  v_def text;
  v_new text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'heroloop_api.game_state_load_context(uuid)',
    'heroloop_api.game_state_save_context(uuid)'
  ] LOOP
    v_def := pg_get_functiondef(v_signature::regprocedure);
    v_new := replace(v_def,
      $find$'enchant_stats_version', item.enchant_stats_version$find$,
      $find$'enchant_stats_version', item.enchant_stats_version,
        'item_roll_version', item.item_roll_version$find$);
    IF v_new = v_def THEN
      RAISE EXCEPTION 'item_roll_v5_context_patch_failed:%', v_signature;
    END IF;
    EXECUTE v_new;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.market_item_json(public.player_items) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_item_json(public.player_items) TO service_role;
