-- Seeker read-only Admin projection: match its approved 200-level Hero cap.
-- Does not modify gameplay Power, player saves, currency or rewards.
DO $$
DECLARE
  v_definition text := pg_get_functiondef('admin.game_registry_hero_power(text,numeric,numeric,jsonb)'::regprocedure);
  v_old text := 'least(99, greatest(1, floor(coalesce(p_level, 0))::integer))';
  v_new text := 'least(200, greatest(1, floor(coalesce(p_level, 0))::integer))';
  v_mastery text := 'power(1::double precision + 0.014::double precision, v_level - 1)';
BEGIN
  IF position(v_new in v_definition) > 0 THEN RETURN; END IF;
  IF position(v_old in v_definition) = 0 THEN
    RAISE EXCEPTION 'admin_hero_power_level_cap_definition_mismatch';
  END IF;
  IF position(v_mastery in v_definition) = 0 THEN
    RAISE EXCEPTION 'admin_hero_power_mastery_definition_mismatch';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE replace(v_definition, v_mastery,
    'power(1::double precision + 0.014::double precision, LEAST(99, v_level) - 1) * (1 + GREATEST(0, v_level - 99) * 0.007::double precision)');
END $$;
