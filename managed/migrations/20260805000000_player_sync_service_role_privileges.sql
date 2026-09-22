BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.players,
  public.player_saves,
  public.summon_events,
  public.token_pool,
  public.rarity_supply
TO service_role;

GRANT EXECUTE ON FUNCTION public.record_player_heartbeat(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_player_tokens(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_token_distribution(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_token_spend(uuid, uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_hero_summon(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_hero_ascension(uuid, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_boost_max_active(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.summon_boss(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_limited_item(uuid, text, text, text, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_player_item(uuid, uuid) TO service_role;

COMMIT;
