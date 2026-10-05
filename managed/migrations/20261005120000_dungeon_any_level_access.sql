-- Founder 2026-10-05 (Staging2 hackathon): Dungeons open at any Account Level. Attempts, weekly Scroll
-- eligibility and every other Dungeon rule stay unchanged; only the Level 30 gate is lifted.
CREATE OR REPLACE FUNCTION public.dungeon_unlocks(p_account_level integer, p_max_depth_cleared integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'depth_1', p_account_level >= 1,
    'depth_2', p_account_level >= 1,
    'depth_3', p_account_level >= 1
  )
$$;

DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_start(uuid,integer,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_old text := 'IF v_account_level < 30 THEN';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'dungeon_start_level_gate_definition_mismatch';
  END IF;
  EXECUTE replace(v_definition, v_old, 'IF v_account_level < 1 THEN');
END;
$$;
