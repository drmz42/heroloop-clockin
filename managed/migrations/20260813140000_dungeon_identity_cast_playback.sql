DO $$
DECLARE
  v_definition text:=pg_get_functiondef('public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid)'::regprocedure);
  v_old text:='v_identity_casts:=GREATEST(0,FLOOR';
  v_new text:='v_identity_casts:=GREATEST(1,FLOOR';
BEGIN
  IF position(v_old in v_definition)=0 THEN
    RAISE EXCEPTION 'dungeon_boss_identity_cast_definition_mismatch';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
END $$;

REVOKE ALL ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) TO service_role;
