CREATE OR REPLACE FUNCTION heroloop_api.game_state_load_context(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_market_recovery jsonb;
  v_save jsonb;
  v_items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.player_saves WHERE player_id = p_player_id) THEN
    RETURN jsonb_build_object('state', NULL, 'revision', NULL, 'migrated_items', 0,
      'items', '[]'::jsonb, 'legacy_market_recovery',
      jsonb_build_object('status', 'missing', 'blocked', true, 'code', 'legacy_market_state_missing'));
  END IF;
  v_market_recovery := public.migrate_legacy_market_listings(p_player_id);
  v_save := public.migrate_legacy_player_items(p_player_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'base_item_id', item.base_item_id,
    'item_level', item.item_level,
    'stats', item.stats,
    'power', item.power,
    'locked', item.locked,
    'enchant_level', item.enchant_level,
    'reroll_count', item.reroll_count,
    'enchant_stats_version', item.enchant_stats_version
  ) ORDER BY item.created_at, item.id), '[]'::jsonb)
  INTO v_items
  FROM public.player_items item
  WHERE item.player_id = p_player_id AND item.removed_at IS NULL;
  RETURN v_save || jsonb_build_object('items', v_items, 'legacy_market_recovery', v_market_recovery);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.game_state_load_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.game_state_load_context(uuid) TO heroloop_api;
COMMENT ON FUNCTION heroloop_api.game_state_load_context(uuid) IS
  'Bounded save load with fail-closed once-only legacy Market recovery and canonical item ledger context.';
