DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_room_action(uuid,uuid,bigint,text,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_fixed text;
BEGIN
  IF (length(v_definition) - length(replace(v_definition, 'rarity_set.multiplier', '')))
      / length('rarity_set.multiplier') <> 3 THEN
    RAISE EXCEPTION 'dungeon_room_action_definition_mismatch';
  END IF;
  v_fixed := replace(v_definition, 'rarity_set.multiplier', 'MAX(rarity_set.multiplier)');
  EXECUTE v_fixed;
END;
$$;
