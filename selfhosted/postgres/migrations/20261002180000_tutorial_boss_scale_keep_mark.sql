-- The Retinue room was weakened, but dungeon_room_complete rebuilds run_state before it
-- reveals the Shared Boss, which dropped the tutorial_boss mark and left the Boss at full
-- strength. The trigger now carries the mark from OLD to NEW run_state.

CREATE OR REPLACE FUNCTION public.dungeon_tutorial_boss_scale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- summon_boss inserts its encounter directly at room 4 with three cleared rooms.
    IF NEW.room = 4 AND NEW.run_state->>'rooms_cleared' = '3'
      AND public.tutorial_boss_eligible((SELECT state FROM public.player_saves WHERE player_id = NEW.player_id)) THEN
      NEW.run_state := NEW.run_state || '{"tutorial_boss":true}'::jsonb;
    END IF;
  ELSE
    -- dungeon_room_complete rebuilds run_state before revealing the Shared Boss; keep the mark.
    IF OLD.run_state->>'tutorial_boss' = 'true' AND NOT COALESCE(NEW.run_state ? 'tutorial_boss', false) THEN
      NEW.run_state := COALESCE(NEW.run_state, '{}'::jsonb) || '{"tutorial_boss":true}'::jsonb;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.run_state->>'tutorial_boss' = 'true'
    AND NEW.room_state->>'status' = 'ready'
    AND NEW.room_state->>'kind' IN ('retinue', 'shared_boss')
    AND jsonb_typeof(NEW.room_state->'enemies') = 'array'
    AND NOT COALESCE((NEW.room_state->>'tutorial_scaled')::boolean, false) THEN
    NEW.room_state := jsonb_set(NEW.room_state, '{enemies}', (
      SELECT COALESCE(jsonb_agg(enemy || jsonb_build_object(
        'max_hp', GREATEST(1, ROUND((enemy->>'max_hp')::numeric * 0.2)),
        'current_hp', GREATEST(1, ROUND((enemy->>'current_hp')::numeric * 0.2)),
        'atk', GREATEST(1, ROUND((enemy->>'atk')::numeric * 0.4)),
        'def', GREATEST(0, ROUND((enemy->>'def')::numeric * 0.5))) ORDER BY ordinality), '[]'::jsonb)
      FROM jsonb_array_elements(NEW.room_state->'enemies') WITH ORDINALITY AS enemies(enemy, ordinality)))
      || '{"tutorial_scaled":true}'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

