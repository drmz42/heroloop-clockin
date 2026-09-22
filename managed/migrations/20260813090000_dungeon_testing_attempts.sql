ALTER TABLE public.dungeon_player_state
  DROP CONSTRAINT dungeon_player_state_attempts_remaining_check;

ALTER TABLE public.dungeon_player_state
  ALTER COLUMN attempts_remaining SET DEFAULT 100;

UPDATE public.dungeon_player_state
SET attempts_remaining = 100, updated_at = now();

ALTER TABLE public.dungeon_player_state
  ADD CONSTRAINT dungeon_player_state_attempts_remaining_check
  CHECK (attempts_remaining BETWEEN 0 AND 100);

DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_status(uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_attempts_old text := 'COALESCE(v_attempts, 3) ELSE 3 END';
  v_attempts_new text := 'COALESCE(v_attempts, 100) ELSE 100 END';
  v_max_old text := E'''attempts_max'', 3';
  v_max_new text := E'''attempts_max'', 100';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_attempts_old, ''))) / length(v_attempts_old) <> 1
    OR (length(v_definition) - length(replace(v_definition, v_max_old, ''))) / length(v_max_old) <> 1 THEN
    RAISE EXCEPTION 'dungeon_status_attempt_cap_definition_mismatch';
  END IF;
  EXECUTE replace(replace(v_definition, v_attempts_old, v_attempts_new), v_max_old, v_max_new);
END;
$$;

DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_start(uuid,integer,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_reset_old text := 'attempts_remaining = 3';
  v_reset_new text := 'attempts_remaining = 100';
  v_max_old text := E'''attempts_max'', 3';
  v_max_new text := E'''attempts_max'', 100';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_reset_old, ''))) / length(v_reset_old) <> 1
    OR (length(v_definition) - length(replace(v_definition, v_max_old, ''))) / length(v_max_old) <> 1 THEN
    RAISE EXCEPTION 'dungeon_start_attempt_cap_definition_mismatch';
  END IF;
  EXECUTE replace(replace(v_definition, v_reset_old, v_reset_new), v_max_old, v_max_new);
END;
$$;
