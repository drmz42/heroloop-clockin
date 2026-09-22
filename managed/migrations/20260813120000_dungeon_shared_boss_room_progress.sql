DO $$
DECLARE
  v_definition text:=pg_get_functiondef('public.dungeon_room_complete(uuid,uuid,bigint,uuid)'::regprocedure);
  v_old text:='v_rooms_cleared:=CASE WHEN v_outcome=''cleared'' THEN LEAST(v_encounter.room,4) ELSE v_encounter.room-1 END';
  v_new text:='v_rooms_cleared:=CASE WHEN v_outcome=''cleared'' AND v_encounter.room=4 AND v_encounter.room_state->>''kind''=''retinue'' THEN 3 WHEN v_outcome=''cleared'' THEN LEAST(v_encounter.room,4) ELSE v_encounter.room-1 END';
BEGIN
  IF position(v_old in v_definition)=0 THEN
    RAISE EXCEPTION 'dungeon_room_complete_progress_definition_mismatch';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
END $$;

REVOKE ALL ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) TO service_role;
