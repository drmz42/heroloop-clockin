CREATE OR REPLACE FUNCTION public.dungeon_shared_boss_enemy(
  p_depth integer, p_party_size integer, p_boss jsonb
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = public AS $$
DECLARE
  v_id text := p_boss->>'boss_id';
  v_base_hp numeric := CASE p_depth WHEN 1 THEN 639 WHEN 2 THEN 2213 ELSE 5402 END;
  v_base_atk numeric := CASE p_depth WHEN 1 THEN 62 WHEN 2 THEN 202 ELSE 467 END;
  v_base_def numeric := CASE p_depth WHEN 1 THEN 19 WHEN 2 THEN 73 ELSE 217 END;
  v_scale numeric := CASE p_depth WHEN 1 THEN 0.9682 WHEN 2 THEN 1.0715 ELSE 1.2512 END;
  v_hp_identity numeric := CASE v_id WHEN 'iron-warden' THEN 1.10 WHEN 'ash-warlock' THEN 0.92
    WHEN 'rift-behemoth' THEN 1.05 WHEN 'grave-necromancer' THEN 0.65 ELSE 1 END;
  v_atk_identity numeric := CASE v_id WHEN 'ash-warlock' THEN 1.08 WHEN 'thorn-shaman' THEN 0.96
    WHEN 'rift-behemoth' THEN 0.75 WHEN 'grave-necromancer' THEN 0.85 ELSE 1 END;
  v_def_identity numeric := CASE v_id WHEN 'iron-warden' THEN 1.15 WHEN 'ash-warlock' THEN 0.95
    WHEN 'rift-behemoth' THEN 1.08 WHEN 'grave-necromancer' THEN 0.95 ELSE 1 END;
  v_hp bigint;
BEGIN
  IF p_depth NOT BETWEEN 1 AND 3 OR p_party_size NOT BETWEEN 1 AND 3
    OR v_id NOT IN ('iron-warden','ash-warlock','thorn-shaman','rift-behemoth','grave-necromancer') THEN
    RAISE EXCEPTION 'dungeon_room_state_invalid';
  END IF;
  v_hp := ROUND(v_base_hp * power(p_party_size::numeric, 1.2) * 2.3 * v_hp_identity * v_scale);
  RETURN jsonb_build_object(
    'unit_id', 'shared-boss-' || v_id, 'lane', 0,
    'boss_id', v_id, 'name', p_boss->>'name',
    'max_hp', v_hp, 'current_hp', v_hp,
    'atk', ROUND(v_base_atk * 0.35 * v_atk_identity * v_scale),
    'def', ROUND(v_base_def * 1.25 * v_def_identity * v_scale),
    'speed', 110, 'alive', true, 'shared_target', true
  );
END;
$$;

DO $$
DECLARE v_definition text:=pg_get_functiondef('public.dungeon_room_one_action(uuid,uuid,bigint,text,uuid)'::regprocedure);
BEGIN
  IF (length(v_definition)-length(replace(v_definition,'public.dungeon_room_one_action','')))/length('public.dungeon_room_one_action')<>1
    OR (length(v_definition)-length(replace(v_definition,'v_encounter.seed, 1,','')))/length('v_encounter.seed, 1,')<>4
    OR position('v_encounter.room <> 1 OR v_encounter.room_state IS NULL' in v_definition)=0 THEN
    RAISE EXCEPTION 'dungeon_room_one_action_definition_mismatch';
  END IF;
  v_definition:=replace(v_definition,'public.dungeon_room_one_action','public.dungeon_shared_boss_action');
  v_definition:=replace(v_definition,'v_encounter.room <> 1 OR v_encounter.room_state IS NULL',
    'v_encounter.room <> 4 OR v_encounter.room_state IS NULL OR v_encounter.room_state->>''kind'' <> ''shared_boss''');
  v_definition:=replace(v_definition,'v_encounter.seed, 1,','v_encounter.seed, 5,');
  v_definition:=replace(v_definition,'''guards_defeated''','''boss_defeated''');
  v_definition:=replace(v_definition,
    'OR (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = ''enemy'')'||chr(10)||'      <> jsonb_array_length(v_encounter.roster_snapshot)',
    'OR (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = ''enemy'') <> 1');
  v_definition:=replace(v_definition,'v_event_ms > 120000','v_event_ms > 240000');
  v_definition:=replace(v_definition,'LEAST(120000, ROUND(v_event_ms))','LEAST(240000, ROUND(v_event_ms))');
  EXECUTE v_definition;
END $$;

CREATE OR REPLACE FUNCTION public.dungeon_room_action(
  p_player_id uuid,p_encounter_id uuid,p_expected_revision bigint,p_action_kind text,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_room integer; v_kind text;
BEGIN
  SELECT COALESCE((result->>'room')::integer,0), result->'room_state'->>'kind' INTO v_room,v_kind
  FROM public.dungeon_events WHERE idempotency_key=p_idempotency_key AND action='room_action';
  IF COALESCE(v_room,0)=0 THEN SELECT room,room_state->>'kind' INTO v_room,v_kind
    FROM public.dungeon_encounters WHERE id=p_encounter_id AND player_id=p_player_id; END IF;
  IF v_room=2 THEN RETURN public.dungeon_room_two_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  ELSIF v_room=3 THEN RETURN public.dungeon_room_three_treasure_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  ELSIF v_room=4 AND v_kind='shared_boss' THEN RETURN public.dungeon_shared_boss_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
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
  v_party_size integer; v_boss_enemy jsonb;
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
  v_rooms_cleared:=CASE
    WHEN v_outcome='cleared' AND v_encounter.room=4 AND v_encounter.room_state->>'kind'='retinue' THEN 3
    WHEN v_outcome='cleared' THEN LEAST(v_encounter.room,4)
    ELSE v_encounter.room-1 END;
  v_run_state:=jsonb_build_object('heroes',v_encounter.room_state->'heroes','rooms_cleared',v_rooms_cleared);

  IF v_outcome='cleared' AND v_encounter.room=4 AND v_encounter.room_state->>'kind'='retinue' THEN
    SELECT count(*) INTO v_party_size FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero
    WHERE COALESCE((hero->>'alive')::boolean,false);
    v_boss_enemy:=public.dungeon_shared_boss_enemy(v_encounter.depth,v_party_size,v_encounter.room_state->'boss');
    UPDATE public.dungeon_encounters SET run_state=v_run_state,
      room_state=jsonb_build_object('room',4,'kind','shared_boss','status','ready','sequence',0,'max_seconds',240,
        'combat_balance_version','2026.08.13-dungeon-room-v1','heroes',v_encounter.room_state->'heroes',
        'enemies',jsonb_build_array(v_boss_enemy),'boss',(v_encounter.room_state->'boss')||jsonb_build_object(
          'status','vulnerable','max_hp',v_boss_enemy->'max_hp','current_hp',v_boss_enemy->'current_hp')),
      room_started_at=now(),revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSIF v_encounter.room=4 AND v_encounter.room_state->>'kind'='shared_boss' THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,
      status=CASE WHEN v_outcome='cleared' THEN 'completed' ELSE 'failed' END,
      revision=revision+1,completed_at=now() WHERE id=v_encounter.id RETURNING * INTO v_encounter;
    IF v_outcome='cleared' THEN
      UPDATE public.dungeon_player_state SET max_depth_cleared=GREATEST(max_depth_cleared,v_encounter.depth),updated_at=now()
      WHERE player_id=p_player_id;
    END IF;
  ELSIF v_outcome='cleared' THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,room=room+1,room_state=NULL,
      room_started_at=NULL,revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSE
    UPDATE public.dungeon_encounters SET run_state=v_run_state,status='failed',revision=revision+1,
      completed_at=now() WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  END IF;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'status',v_encounter.status,'room',v_encounter.room,
    'revision',v_encounter.revision,'run_state',v_encounter.run_state,'room_state',v_encounter.room_state,'attempt_refunded',false,
    'boss_defeated',v_encounter.status='completed','rewards_enabled',false);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_complete',v_request,v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_shared_boss_enemy(integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) TO service_role;
