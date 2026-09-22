-- Slow progression from level 20 onward and enforce the level 99 ceiling on every save path.
CREATE OR REPLACE FUNCTION public.account_xp_needed(p_level integer)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT CASE
    WHEN p_level < 20 THEN ROUND(1800 + p_level * 85)::integer
    WHEN p_level < 29 THEN ROUND(10400 + (p_level - 20) * 360)::integer
    ELSE LEAST(36000, ROUND(14000 + (p_level - 29) * 1100)::integer)
  END;
$$;

CREATE OR REPLACE FUNCTION public.hero_xp_needed(p_level integer)
RETURNS integer
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT GREATEST(1, ROUND(public.account_xp_needed(p_level) / 1.3)::integer);
$$;

-- Keep each earned account level when translating existing lifetime XP to the slower curve.
UPDATE public.player_saves
SET state = jsonb_set(
  state,
  '{accountXp}',
  to_jsonb(GREATEST(
    LEAST(COALESCE((state->>'accountXp')::bigint, 0), (SELECT SUM(public.account_xp_needed(level)) FROM generate_series(1, 98) AS level)),
    COALESCE((SELECT SUM(public.account_xp_needed(level)) FROM generate_series(1, LEAST(98, GREATEST(1, COALESCE((state->>'accountLevel')::integer, 1))) - 1) AS level), 0)
  ))
);

CREATE OR REPLACE FUNCTION public.enforce_player_save_level_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_xp bigint;
  v_xp bigint;
  v_level integer := 1;
  v_level_start bigint := 0;
  v_heroes jsonb;
BEGIN
  SELECT SUM(public.account_xp_needed(level)) INTO v_max_xp FROM generate_series(1, 98) AS level;
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

DROP TRIGGER IF EXISTS player_saves_level_cap ON public.player_saves;
CREATE TRIGGER player_saves_level_cap
BEFORE UPDATE OF state ON public.player_saves
FOR EACH ROW EXECUTE FUNCTION public.enforce_player_save_level_cap();

-- Run the guard once for existing heroes and clamp the public summary as well.
UPDATE public.player_saves SET state = state;
UPDATE public.players SET account_level = LEAST(99, GREATEST(1, account_level));

REVOKE ALL ON FUNCTION public.enforce_player_save_level_cap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_player_save_level_cap() TO service_role;
