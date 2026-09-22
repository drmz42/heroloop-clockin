DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_room_one_action(uuid,uuid,bigint,text,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
BEGIN
  IF (length(v_definition)-length(replace(v_definition,'public.dungeon_room_one_action','')))
      /length('public.dungeon_room_one_action') <> 1
    OR (length(v_definition)-length(replace(v_definition,'v_encounter.room <> 1 OR v_encounter.room_state IS NULL','')))
      /length('v_encounter.room <> 1 OR v_encounter.room_state IS NULL') <> 1
    OR (length(v_definition)-length(replace(v_definition,'v_encounter.seed, 1,','')))
      /length('v_encounter.seed, 1,') <> 4
    OR (length(v_definition)-length(replace(v_definition,'''guards_defeated''','')))
      /length('''guards_defeated''') <> 1 THEN
    RAISE EXCEPTION 'dungeon_room_one_action_definition_mismatch';
  END IF;
  v_definition := replace(v_definition,'public.dungeon_room_one_action','public.dungeon_room_three_treasure_action');
  v_definition := replace(v_definition,
    'v_encounter.room <> 1 OR v_encounter.room_state IS NULL',
    'v_encounter.room <> 3 OR v_encounter.room_state IS NULL OR v_encounter.room_state->>''kind'' <> ''treasure_guards''');
  v_definition := replace(v_definition,'v_encounter.seed, 1,','v_encounter.seed, 3,');
  v_definition := replace(v_definition,'''guards_defeated''','''treasure_guards_defeated''');
  EXECUTE v_definition;
END $$;

CREATE OR REPLACE FUNCTION public.dungeon_room_action(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint,
  p_action_kind text, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room integer;
BEGIN
  SELECT COALESCE((result->>'room')::integer,0) INTO v_room
  FROM public.dungeon_events WHERE idempotency_key=p_idempotency_key AND action='room_action';
  IF COALESCE(v_room,0)=0 THEN
    SELECT room INTO v_room FROM public.dungeon_encounters WHERE id=p_encounter_id AND player_id=p_player_id;
  END IF;
  IF v_room=2 THEN
    RETURN public.dungeon_room_two_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  ELSIF v_room=3 THEN
    RETURN public.dungeon_room_three_treasure_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  END IF;
  RETURN public.dungeon_room_one_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_room_three_treasure_action(uuid,uuid,bigint,text,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) TO service_role;
