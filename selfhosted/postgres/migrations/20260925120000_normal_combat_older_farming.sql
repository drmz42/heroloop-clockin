-- All discovered, level-accessible Locations remain farmable for Gold and XP.
-- $HERO eligibility stays in its separate latest-or-previous Location gate.
DO $$
DECLARE
  v_definition text;
  v_old_lower_bound text := E'\n    OR p_location < GREATEST(1, LEAST(GREATEST(1, COALESCE((v_save.state->>''highestLocation'')::integer, 1)), v_location_cap) - 1)';
BEGIN
  v_definition := pg_get_functiondef('public.normal_combat_prepare(uuid,uuid,integer)'::regprocedure);
  IF strpos(v_definition, v_old_lower_bound) = 0
    OR strpos(v_definition, 'IF p_location > LEAST(GREATEST(1, COALESCE((v_save.state->>''highestLocation'')::integer, 1)), v_location_cap)') = 0
  THEN
    RAISE EXCEPTION 'normal_combat_prepare_location_contract_changed';
  END IF;
  EXECUTE replace(v_definition, v_old_lower_bound, '');
END;
$$;
