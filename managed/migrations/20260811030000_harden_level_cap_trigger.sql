-- Accept JSON numbers from browser saves while enforcing integer level/XP storage.
CREATE OR REPLACE FUNCTION public.enforce_player_save_level_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_xp constant bigint := 2445910;
  v_xp bigint;
  v_level integer := 1;
  v_level_start bigint := 0;
  v_heroes jsonb;
BEGIN
  v_xp := LEAST(v_max_xp, GREATEST(0, CASE WHEN COALESCE(NEW.state->>'accountXp', '') ~ '^[0-9]+([.][0-9]+)?$' THEN FLOOR((NEW.state->>'accountXp')::numeric)::bigint ELSE 0 END));
  WHILE v_level < 99 AND v_xp >= v_level_start + public.account_xp_needed(v_level) LOOP
    v_level_start := v_level_start + public.account_xp_needed(v_level);
    v_level := v_level + 1;
  END LOOP;

  SELECT COALESCE(jsonb_agg(
    jsonb_set(
      jsonb_set(hero, '{level}', to_jsonb(LEAST(99, GREATEST(1, CASE WHEN COALESCE(hero->>'level', '') ~ '^[0-9]+([.][0-9]+)?$' THEN FLOOR((hero->>'level')::numeric)::integer ELSE 1 END)))),
      '{xp}',
      to_jsonb(CASE WHEN CASE WHEN COALESCE(hero->>'level', '') ~ '^[0-9]+([.][0-9]+)?$' THEN FLOOR((hero->>'level')::numeric)::integer ELSE 1 END >= 99 THEN 0 ELSE GREATEST(0, CASE WHEN COALESCE(hero->>'xp', '') ~ '^[0-9]+([.][0-9]+)?$' THEN FLOOR((hero->>'xp')::numeric)::bigint ELSE 0 END) END)
    ) ORDER BY ordinal
  ), '[]'::jsonb)
  INTO v_heroes
  FROM jsonb_array_elements(COALESCE(NEW.state->'ownedHeroes', '[]'::jsonb)) WITH ORDINALITY AS entry(hero, ordinal);

  NEW.state := jsonb_set(jsonb_set(jsonb_set(NEW.state, '{accountXp}', to_jsonb(v_xp)), '{accountLevel}', to_jsonb(v_level)), '{ownedHeroes}', v_heroes);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_player_save_level_cap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_player_save_level_cap() TO service_role;
