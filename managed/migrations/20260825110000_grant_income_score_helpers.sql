-- The batch score RPC invokes these helpers with the caller's privileges.
-- Keep them unavailable to player roles while allowing the service-only RPC path.
REVOKE ALL ON FUNCTION public.canonical_hero_income_score(numeric, integer, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hero_income_training_penalty(integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.canonical_hero_income_score(numeric, integer, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.hero_income_training_penalty(integer)
  TO service_role;
