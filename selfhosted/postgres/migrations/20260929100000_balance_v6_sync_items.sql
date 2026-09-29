\set ON_ERROR_STOP on

-- Balance v6: the server Power summary (profile sync) adds each item's slot base stat, which
-- needs its Item Level, and applies the Enchant curve by enchant_stats_version.
DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.sync_context(uuid)'::regprocedure);
  v_new := replace(v_def,
    $find$'rarity', item.rarity,
        'stats', item.stats,
        'enchant_level', item.enchant_level
      )$find$,
    $find$'rarity', item.rarity,
        'item_level', item.item_level,
        'stats', item.stats,
        'enchant_level', item.enchant_level,
        'enchant_stats_version', item.enchant_stats_version
      )$find$);
  IF v_new = v_def THEN RAISE EXCEPTION 'balance_v6_sync_context_patch_failed'; END IF;
  EXECUTE v_new;
END;
$$;
