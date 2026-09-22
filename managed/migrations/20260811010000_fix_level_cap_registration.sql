-- New accounts are constructed by the server at level 1; enforce the cap on every later state mutation.
DROP TRIGGER IF EXISTS player_saves_level_cap ON public.player_saves;
CREATE TRIGGER player_saves_level_cap
BEFORE UPDATE OF state ON public.player_saves
FOR EACH ROW EXECUTE FUNCTION public.enforce_player_save_level_cap();
