CREATE OR REPLACE FUNCTION public.dungeon_room_four_retinue_enemies(p_depth integer, p_heroes jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'unit_id', 'retinue-guard-' || (hero->>'position'),
    'lane', (hero->>'position')::integer,
    'max_hp', CASE p_depth WHEN 1 THEN 371 WHEN 2 THEN 1423 WHEN 3 THEN 4055 END,
    'current_hp', CASE p_depth WHEN 1 THEN 371 WHEN 2 THEN 1423 WHEN 3 THEN 4055 END,
    'atk', CASE p_depth WHEN 1 THEN 15 WHEN 2 THEN 54 WHEN 3 THEN 146 END,
    'def', CASE p_depth WHEN 1 THEN 14 WHEN 2 THEN 59 WHEN 3 THEN 204 END,
    'speed', CASE p_depth WHEN 1 THEN 99.630 WHEN 2 THEN 102.888 WHEN 3 THEN 102.888 END,
    'alive', true
  ) ORDER BY (hero->>'position')::integer), '[]'::jsonb)
  FROM jsonb_array_elements(p_heroes) heroes(hero)
  WHERE COALESCE((hero->>'alive')::boolean, false)
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_start(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb:=jsonb_build_object('encounter_id',p_encounter_id,'expected_revision',p_expected_revision);
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_run_state jsonb; v_room_state jsonb; v_modifier text; v_boss_id text; v_boss_name text; v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:'||p_player_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id<>p_player_id OR v_existing.action<>'room_start' OR v_existing.request<>v_request THEN
      RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'dungeon_invalid_revision'; END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id=p_encounter_id AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status<>'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision<>p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room NOT IN (1,2,4) THEN RAISE EXCEPTION 'dungeon_room_not_available'; END IF;
  IF v_encounter.room_state IS NOT NULL THEN RAISE EXCEPTION 'dungeon_room_already_started'; END IF;

  v_run_state:=CASE WHEN v_encounter.room=1 AND v_encounter.run_state='{}'::jsonb
    THEN public.dungeon_initial_run_state(v_encounter.roster_snapshot) ELSE v_encounter.run_state END;
  IF jsonb_typeof(v_run_state->'heroes') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_run_state->'heroes') IS DISTINCT FROM jsonb_array_length(v_encounter.roster_snapshot)
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_run_state->'heroes') heroes(hero)
      WHERE COALESCE((hero->>'alive')::boolean,false)) THEN RAISE EXCEPTION 'dungeon_run_state_invalid'; END IF;

  IF v_encounter.room=1 THEN
    v_room_state:=jsonb_build_object('room',1,'kind','normal_guards','status','ready','sequence',0,'max_seconds',120,
      'combat_balance_version','2026.08.13-dungeon-room-v1','heroes',v_run_state->'heroes',
      'enemies',public.dungeon_room_one_enemies(v_encounter.depth,jsonb_array_length(v_run_state->'heroes')));
  ELSIF v_encounter.room=2 THEN
    IF COALESCE((v_run_state->>'rooms_cleared')::integer,0)<>1 THEN RAISE EXCEPTION 'dungeon_room_not_available'; END IF;
    v_modifier:=CASE mod(mod(hashtextextended(v_encounter.seed::text||':room2:modifier',0),5)+5,5)
      WHEN 0 THEN 'stone_skin' WHEN 1 THEN 'blood_oath' WHEN 2 THEN 'bound_souls'
      WHEN 3 THEN 'mark_of_the_abyss' ELSE 'last_fury' END;
    v_room_state:=jsonb_build_object('room',2,'kind','elite_guards','status','ready','sequence',0,'max_seconds',120,
      'combat_balance_version','2026.08.13-dungeon-room-v1','modifier',v_modifier,
      'modifier_state',jsonb_build_object('trigger_count',0,'next_mark_ms',
        CASE WHEN v_modifier='mark_of_the_abyss' THEN 12000 ELSE NULL END),
      'heroes',v_run_state->'heroes','enemies',public.dungeon_room_two_enemies(v_encounter.depth,v_run_state->'heroes',v_modifier));
  ELSE
    IF COALESCE((v_run_state->>'rooms_cleared')::integer,0)<>3 THEN RAISE EXCEPTION 'dungeon_room_not_available'; END IF;
    SELECT boss_id,boss_name INTO v_boss_id,v_boss_name FROM (VALUES
      (0,'iron-warden','Iron Warden'),(1,'ash-warlock','Ash Warlock'),(2,'thorn-shaman','Thorn Shaman'),
      (3,'rift-behemoth','Rift Behemoth'),(4,'grave-necromancer','Grave Necromancer')
    ) bosses(index,boss_id,boss_name)
    WHERE index=mod(mod(hashtextextended(v_encounter.seed::text||':room4:boss',0),5)+5,5);
    v_room_state:=jsonb_build_object('room',4,'kind','retinue','status','ready','sequence',0,'max_seconds',120,
      'combat_balance_version','2026.08.13-dungeon-room-v1','heroes',v_run_state->'heroes',
      'enemies',public.dungeon_room_four_retinue_enemies(v_encounter.depth,v_run_state->'heroes'),
      'boss',jsonb_build_object('boss_id',v_boss_id,'name',v_boss_name,'status','protected_by_retinue'));
  END IF;

  UPDATE public.dungeon_encounters SET run_state=v_run_state,room_state=v_room_state,
    room_started_at=now(),revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'room',v_encounter.room,'revision',v_encounter.revision,
    'run_state',v_encounter.run_state,'room_state',v_encounter.room_state,'room_started_at',v_encounter.room_started_at);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_start',v_request,v_result);
  RETURN v_result;
END;
$$;

DO $$
DECLARE v_definition text:=pg_get_functiondef('public.dungeon_room_one_action(uuid,uuid,bigint,text,uuid)'::regprocedure);
BEGIN
  IF (length(v_definition)-length(replace(v_definition,'public.dungeon_room_one_action','')))/length('public.dungeon_room_one_action')<>1
    OR (length(v_definition)-length(replace(v_definition,'v_encounter.seed, 1,','')))/length('v_encounter.seed, 1,')<>4
    OR position('v_encounter.room <> 1 OR v_encounter.room_state IS NULL' in v_definition)=0
    OR position('''guards_defeated''' in v_definition)=0 THEN RAISE EXCEPTION 'dungeon_room_one_action_definition_mismatch'; END IF;
  v_definition:=replace(v_definition,'public.dungeon_room_one_action','public.dungeon_room_four_retinue_action');
  v_definition:=replace(v_definition,'v_encounter.room <> 1 OR v_encounter.room_state IS NULL',
    'v_encounter.room <> 4 OR v_encounter.room_state IS NULL OR v_encounter.room_state->>''kind'' <> ''retinue''');
  v_definition:=replace(v_definition,'v_encounter.seed, 1,','v_encounter.seed, 4,');
  v_definition:=replace(v_definition,'''guards_defeated''','''retinue_defeated''');
  v_definition:=replace(v_definition,
    'OR (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = ''enemy'')'||chr(10)||'      <> jsonb_array_length(v_encounter.roster_snapshot)',
    'OR (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = ''enemy'')'||chr(10)||'      <> (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = ''hero'' AND alive)');
  EXECUTE v_definition;
END $$;

CREATE OR REPLACE FUNCTION public.dungeon_room_action(
  p_player_id uuid,p_encounter_id uuid,p_expected_revision bigint,p_action_kind text,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room integer;
BEGIN
  SELECT COALESCE((result->>'room')::integer,0) INTO v_room FROM public.dungeon_events
  WHERE idempotency_key=p_idempotency_key AND action='room_action';
  IF COALESCE(v_room,0)=0 THEN SELECT room INTO v_room FROM public.dungeon_encounters
    WHERE id=p_encounter_id AND player_id=p_player_id; END IF;
  IF v_room=2 THEN RETURN public.dungeon_room_two_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  ELSIF v_room=3 THEN RETURN public.dungeon_room_three_treasure_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  ELSIF v_room=4 THEN RETURN public.dungeon_room_four_retinue_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  END IF;
  RETURN public.dungeon_room_one_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_complete(
  p_player_id uuid,p_encounter_id uuid,p_expected_revision bigint,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb:=jsonb_build_object('encounter_id',p_encounter_id,'expected_revision',p_expected_revision);
  v_encounter public.dungeon_encounters%ROWTYPE; v_run_state jsonb; v_result jsonb; v_outcome text; v_rooms_cleared integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:'||p_player_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id<>p_player_id OR v_existing.action<>'room_complete' OR v_existing.request<>v_request THEN
      RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'dungeon_invalid_revision'; END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters WHERE id=p_encounter_id AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status<>'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision<>p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room NOT IN (1,2,3,4) OR v_encounter.room_state IS NULL THEN RAISE EXCEPTION 'dungeon_room_not_ready'; END IF;
  v_outcome:=v_encounter.room_state->>'status';
  IF v_outcome NOT IN ('cleared','failed') THEN RAISE EXCEPTION 'dungeon_room_not_resolved'; END IF;
  IF jsonb_typeof(v_encounter.room_state->'heroes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'dungeon_room_state_invalid'; END IF;
  v_rooms_cleared:=CASE WHEN v_outcome='cleared' THEN LEAST(v_encounter.room,3) ELSE v_encounter.room-1 END;
  v_run_state:=jsonb_build_object('heroes',v_encounter.room_state->'heroes','rooms_cleared',v_rooms_cleared);
  IF v_outcome='cleared' AND v_encounter.room=4 THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,
      room_state=jsonb_build_object('room',4,'kind','boss_protected','status','boss_locked',
        'combat_balance_version','2026.08.13-dungeon-room-v1','heroes',v_encounter.room_state->'heroes',
        'enemies','[]'::jsonb,'boss',(v_encounter.room_state->'boss')||jsonb_build_object('status','retinue_defeated')),
      room_started_at=NULL,revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSIF v_outcome='cleared' THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,room=room+1,room_state=NULL,
      room_started_at=NULL,revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSE
    UPDATE public.dungeon_encounters SET run_state=v_run_state,status='failed',revision=revision+1,
      completed_at=now() WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  END IF;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'status',v_encounter.status,'room',v_encounter.room,
    'revision',v_encounter.revision,'run_state',v_encounter.run_state,'room_state',v_encounter.room_state,'attempt_refunded',false);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_complete',v_request,v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_room_four_retinue_enemies(integer,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_four_retinue_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.dungeon_room_start(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_start(uuid,uuid,bigint,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) TO service_role;
