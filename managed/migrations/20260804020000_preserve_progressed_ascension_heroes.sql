DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := 'AND COALESCE((hero->>''locked'')::boolean, false) = false';
  v_new text := 'AND COALESCE((hero->>''stars'')::integer, 0) = 0
        AND COALESCE((hero->>''locked'')::boolean, false) = false';
BEGIN
  SELECT pg_get_functiondef(
    'public.settle_hero_ascension(uuid,uuid,text,boolean)'::regprocedure
  ) INTO v_definition;

  IF position('COALESCE((hero->>''stars'')::integer, 0) = 0' IN v_definition) > 0 THEN
    RETURN;
  END IF;

  v_updated := replace(v_definition, v_old, v_new);
  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'settle_hero_ascension eligibility clause not found';
  END IF;

  EXECUTE v_updated;
END;
$migration$;
