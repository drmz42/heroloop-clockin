CREATE OR REPLACE FUNCTION heroloop_api.status_context(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'pool', (SELECT jsonb_build_object('total_distributed', pool.total_distributed, 'distribution_rate', pool.distribution_rate)
      FROM public.token_pool pool WHERE pool.id = 1),
    'player', (SELECT jsonb_build_object(
      'pending_tokens', player.pending_tokens, 'total_claimed', player.total_claimed,
      'boss_keys', player.boss_keys, 'token_balance', player.token_balance,
      'boost_tokens_earned', player.boost_tokens_earned, 'boost_tokens_spent', player.boost_tokens_spent,
      'boost_login_days', player.boost_login_days, 'boost_online_seconds', player.boost_online_seconds,
      'boost_max_active', player.boost_max_active,
      'pity_legendary', player.pity_legendary, 'pity_mythic', player.pity_mythic,
      'pity_cosmic', player.pity_cosmic, 'pity_divine', player.pity_divine,
      'pity_celestial', player.pity_celestial, 'ascension_focus', player.ascension_focus
    ) FROM public.players player WHERE player.player_id = p_player_id),
    'eligible_players', '[]'::jsonb,
    'rarity_supply', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'rarity', supply.rarity, 'existing_count', supply.existing_count, 'max_existing', supply.max_existing
    ) ORDER BY supply.rarity) FROM public.rarity_supply supply
      WHERE supply.rarity IN ('divine', 'celestial', 'cursed', 'immortal', 'god')), '[]'::jsonb),
    'resource', (SELECT jsonb_build_object('state', save.state, 'revision', save.revision)
      FROM public.player_saves save WHERE save.player_id = p_player_id)
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.income_snapshot(p_player_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public
AS $function$ SELECT public.hero_income_snapshot(p_player_id) $function$;

REVOKE ALL ON FUNCTION heroloop_api.income_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.status_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.income_snapshot(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.status_context(uuid) TO heroloop_api;
