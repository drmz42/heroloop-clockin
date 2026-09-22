-- Direct Edge Function saves execute triggers as service_role.
REVOKE ALL ON FUNCTION public.enforce_player_save_level_cap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_player_save_level_cap() TO service_role;
