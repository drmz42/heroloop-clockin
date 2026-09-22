DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  SELECT pg_get_functiondef('public.settle_hero_ascension(uuid,uuid,text,boolean)'::regprocedure)
  INTO v_definition;

  IF v_definition LIKE '%WHEN ''rare'' THEN 4%'
    AND v_definition LIKE '%WHEN ''epic'' THEN 8%'
    AND v_definition LIKE '%WHEN ''legendary'' THEN 12%'
    AND v_definition LIKE '%WHEN ''mythic'' THEN 16%' THEN
    RETURN;
  END IF;

  IF v_definition NOT LIKE '%WHEN ''rare'' THEN 3%'
    OR v_definition NOT LIKE '%WHEN ''epic'' THEN 5%'
    OR v_definition NOT LIKE '%WHEN ''legendary'' THEN 8%'
    OR v_definition NOT LIKE '%WHEN ''mythic'' THEN 12%' THEN
    RAISE EXCEPTION 'unexpected hero ascension price definition';
  END IF;

  v_updated := replace(v_definition, 'WHEN ''rare'' THEN 3', 'WHEN ''rare'' THEN 4');
  v_updated := replace(v_updated, 'WHEN ''epic'' THEN 5', 'WHEN ''epic'' THEN 8');
  v_updated := replace(v_updated, 'WHEN ''legendary'' THEN 8', 'WHEN ''legendary'' THEN 12');
  v_updated := replace(v_updated, 'WHEN ''mythic'' THEN 12', 'WHEN ''mythic'' THEN 16');
  EXECUTE v_updated;
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
    WHEN 'uncommon' THEN (ARRAY[11, 23, 35, 47])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'rare' THEN (ARRAY[5, 10, 14, 17])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'epic' THEN (ARRAY[5, 9, 13, 17])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'legendary' THEN (ARRAY[4, 8, 11, 13])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'mythic' THEN (ARRAY[3, 5, 8, 12])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'cosmic' THEN (ARRAY[2, 3, 4, 5])[LEAST(4, GREATEST(1, p_current_stars / 5 + 1))]
    WHEN 'divine' THEN 2
    WHEN 'celestial' THEN 1
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.hero_ascension_required_duplicates(text, integer) FROM PUBLIC;
