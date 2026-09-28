CREATE OR REPLACE FUNCTION public.dungeon_room_complete(
  p_player_id uuid,p_encounter_id uuid,p_expected_revision bigint,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb:=jsonb_build_object('encounter_id',p_encounter_id,'expected_revision',p_expected_revision);
  v_encounter public.dungeon_encounters%ROWTYPE; v_run_state jsonb; v_result jsonb; v_outcome text; v_rooms_cleared integer;
  v_party_size integer; v_boss_enemy jsonb;
  v_reward_rank bigint; v_scrolls integer := 0; v_preview jsonb; v_save public.player_saves%ROWTYPE; v_resource jsonb;
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

  IF v_encounter.room=4 AND v_encounter.room_state->>'kind'='shared_boss'
    AND v_encounter.room_state->>'status'='reward_locked' THEN
    v_preview:=v_encounter.room_state->'reward_preview';
    IF v_preview->>'reward_table_version'='dungeon-reward-v3' THEN
      v_scrolls:=COALESCE((v_preview->>'summon_scrolls')::integer,0);
      IF v_scrolls NOT IN (0,2) THEN RAISE EXCEPTION 'dungeon_reward_preview_invalid'; END IF;
    END IF;
    IF v_scrolls=2 THEN
      SELECT count(*) INTO v_reward_rank FROM public.dungeon_encounters entry
      WHERE entry.player_id=p_player_id
        AND public.dungeon_week_start(entry.started_at)=public.dungeon_week_start(v_encounter.started_at)
        AND (entry.started_at<v_encounter.started_at OR
          (entry.started_at=v_encounter.started_at AND entry.id<=v_encounter.id));
      IF v_reward_rank>3 THEN RAISE EXCEPTION 'dungeon_reward_entry_limit'; END IF;
      SELECT * INTO v_save FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
      v_resource:=public.apply_resource_entries(p_player_id,p_idempotency_key,'dungeon_scroll_claim',
        encode(extensions.digest(jsonb_build_object('encounter_id',v_encounter.id,'scrolls',2)::text,'sha256'),'hex'),
        '[{"resource_id":"summon_scroll","delta":"2","source_key":"boss_summon_scroll"}]'::jsonb,
        v_save.revision+1);
      UPDATE public.player_saves SET
        state=jsonb_set(state,'{summonScrolls}',to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint),true),
        revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING * INTO v_save;
    END IF;
    UPDATE public.dungeon_encounters SET status='completed',revision=revision+1,completed_at=now(),
      room_state=room_state||jsonb_build_object('reward_preview',v_preview||jsonb_build_object(
        'scrolls_settled',v_scrolls=2),'scrolls_awarded',v_scrolls)
    WHERE id=v_encounter.id RETURNING * INTO v_encounter;
    UPDATE public.dungeon_player_state SET max_depth_cleared=GREATEST(max_depth_cleared,v_encounter.depth),updated_at=now()
    WHERE player_id=p_player_id;
    v_result:=jsonb_build_object(
      'encounter_id',v_encounter.id,'status',v_encounter.status,'room',v_encounter.room,
      'revision',v_encounter.revision,'run_state',v_encounter.run_state,'room_state',v_encounter.room_state,
      'attempt_refunded',false,'boss_defeated',true,'reward_locked',false,
      'reward_lock_acknowledged',true,'rewards_enabled',v_scrolls=2,'scrolls_awarded',v_scrolls,
      'state',CASE WHEN v_scrolls=2 THEN v_save.state ELSE NULL END
    );
    INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
    VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_complete',v_request,v_result);
    RETURN v_result;
  END IF;

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
  ELSIF v_encounter.room=4 AND v_encounter.room_state->>'kind'='shared_boss' AND v_outcome='cleared' THEN
    SELECT count(*) INTO v_reward_rank FROM public.dungeon_encounters entry
    WHERE entry.player_id=p_player_id
      AND public.dungeon_week_start(entry.started_at)=public.dungeon_week_start(v_encounter.started_at)
      AND (entry.started_at<v_encounter.started_at OR
        (entry.started_at=v_encounter.started_at AND entry.id<=v_encounter.id));
    v_scrolls:=CASE WHEN v_reward_rank<=3 THEN 2 ELSE 0 END;
    UPDATE public.dungeon_encounters SET run_state=v_run_state,
      room_state=room_state||jsonb_build_object(
        'status','reward_locked','reward_preview',jsonb_build_object(
          'summon_scrolls',v_scrolls,'dungeon_chests',1,'settled',false,
          'reward_eligible',v_scrolls=2,'reward_table_version','dungeon-reward-v3')),
      revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSIF v_encounter.room=4 AND v_encounter.room_state->>'kind'='shared_boss' THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,status='failed',
      revision=revision+1,completed_at=now() WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSIF v_outcome='cleared' THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,room=room+1,room_state=NULL,
      room_started_at=NULL,revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSE
    UPDATE public.dungeon_encounters SET run_state=v_run_state,status='failed',revision=revision+1,
      completed_at=now() WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  END IF;
  v_result:=jsonb_build_object(
    'encounter_id',v_encounter.id,'status',v_encounter.status,'room',v_encounter.room,
    'revision',v_encounter.revision,'run_state',v_encounter.run_state,'room_state',v_encounter.room_state,
    'attempt_refunded',false,
    'boss_defeated',COALESCE(v_encounter.room=4 AND v_encounter.room_state->>'kind'='shared_boss'
      AND v_encounter.room_state->>'status'='reward_locked',false),
    'reward_locked',COALESCE(v_encounter.room_state->>'status'='reward_locked',false),'rewards_enabled',false
  );
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_complete',v_request,v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) TO service_role;
