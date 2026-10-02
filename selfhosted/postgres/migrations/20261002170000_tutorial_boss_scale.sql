-- Tutorial step 10: a fresh Account Level 1 team could not beat the first Boss Hunt.
-- While the Tutorial is unfinished at step 9 or 10 and no Boss has been killed since
-- the step-8 key grant (the same window as tutorial_boss_key_regrant), the summoned
-- Boss Hunt is marked tutorial_boss. When its Retinue or Shared Boss room is created,
-- enemies get 20% HP, 40% ATK and 50% DEF once. Every other Boss Hunt and Dungeon is unchanged.

CREATE OR REPLACE FUNCTION public.tutorial_boss_eligible(p_state jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_typeof(p_state->'tutorial') = 'object'
    AND NOT COALESCE((p_state#>>'{tutorial,questCompleted}')::boolean, true)
    AND COALESCE((p_state#>>'{tutorial,questOrdinal}')::integer, 11) IN (9, 10)
    AND COALESCE((p_state->>'totalBossKills')::bigint, 0) - COALESCE((p_state#>>'{tutorial,bossKillsAtKeyGrant}')::bigint, 0) < 1
$$;

CREATE OR REPLACE FUNCTION public.dungeon_tutorial_boss_scale()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- summon_boss inserts its encounter directly at room 4 with three cleared rooms.
    IF NEW.room = 4 AND NEW.run_state->>'rooms_cleared' = '3'
      AND public.tutorial_boss_eligible((SELECT state FROM public.player_saves WHERE player_id = NEW.player_id)) THEN
      NEW.run_state := NEW.run_state || '{"tutorial_boss":true}'::jsonb;
    END IF;
  ELSIF NEW.run_state->>'tutorial_boss' = 'true'
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

DROP TRIGGER IF EXISTS dungeon_tutorial_boss_scale ON public.dungeon_encounters;
CREATE TRIGGER dungeon_tutorial_boss_scale BEFORE INSERT OR UPDATE ON public.dungeon_encounters
FOR EACH ROW EXECUTE FUNCTION public.dungeon_tutorial_boss_scale();

REVOKE ALL ON FUNCTION public.tutorial_boss_eligible(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dungeon_tutorial_boss_scale() FROM PUBLIC, anon, authenticated;
