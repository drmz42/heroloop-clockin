CREATE OR REPLACE FUNCTION public.dungeon_unlocks(p_account_level integer, p_max_depth_cleared integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'depth_1', p_account_level >= 30,
    'depth_2', p_account_level >= 30,
    'depth_3', p_account_level >= 30
  )
$$;

DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_start(uuid,integer,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_old text := E'IF (p_depth = 1 AND v_account_level < 30)\n    OR (p_depth = 2 AND (v_account_level < 55 OR v_player_state.max_depth_cleared < 1))\n    OR (p_depth = 3 AND (v_account_level < 80 OR v_player_state.max_depth_cleared < 2)) THEN';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'dungeon_start_definition_mismatch';
  END IF;
  EXECUTE replace(v_definition, v_old, 'IF v_account_level < 30 THEN');
END;
$$;
