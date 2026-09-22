DO $$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.hero_ascension_required_duplicates(text,integer)'::regprocedure)
  INTO v_definition;

  IF v_definition NOT LIKE '%WHEN ''cosmic'' THEN (ARRAY[1, 2, 3, 4])%'
    AND v_definition NOT LIKE '%WHEN ''cosmic'' THEN (ARRAY[2, 3, 4, 5])%' THEN
    RAISE EXCEPTION 'unexpected hero ascension duplicate curve';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.hero_ascension_required_duplicates(
  p_rarity text,
  p_current_stars integer
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT CASE p_rarity
    WHEN 'common' THEN (ARRAY[12, 24, 36, 48])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'uncommon' THEN (ARRAY[9, 18, 27, 36])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'rare' THEN (ARRAY[7, 14, 21, 28])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'epic' THEN (ARRAY[5, 10, 15, 20])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'legendary' THEN (ARRAY[4, 8, 12, 16])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'mythic' THEN (ARRAY[2, 4, 6, 8])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'cosmic' THEN (ARRAY[2, 3, 4, 5])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'divine' THEN 2
    WHEN 'celestial' THEN 1
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.hero_ascension_required_duplicates(text, integer) FROM PUBLIC;
