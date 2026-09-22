ALTER FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid)
  RENAME TO dungeon_shared_boss_basic_action;

CREATE OR REPLACE FUNCTION public.dungeon_shared_boss_action(
  p_player_id uuid,p_encounter_id uuid,p_expected_revision bigint,p_action_kind text,p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_boss jsonb;
  v_target_uid text;
  v_target_power numeric;
  v_heavy_casts integer;
  v_identity_casts integer;
  v_identity_ability text;
  v_heavy_damage numeric;
  v_heroes jsonb;
BEGIN
  v_result:=public.dungeon_shared_boss_basic_action(
    p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key
  );
  IF v_result->'room_state' ? 'heavy_target_uid' THEN RETURN v_result; END IF;

  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id=p_encounter_id AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR v_encounter.room_state->>'kind'<>'shared_boss' THEN
    RAISE EXCEPTION 'dungeon_room_state_invalid';
  END IF;
  v_boss:=v_encounter.room_state->'enemies'->0;
  SELECT hero->>'uid',COALESCE((snapshot->'stats'->>'power')::numeric,0)
    INTO v_target_uid,v_target_power
  FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero
  JOIN LATERAL (
    SELECT value snapshot FROM jsonb_array_elements(v_encounter.roster_snapshot)
    WHERE value->>'uid'=hero->>'uid' LIMIT 1
  ) matched ON true
  WHERE COALESCE((hero->>'alive')::boolean,false)
  ORDER BY COALESCE((snapshot->'stats'->>'power')::numeric,0) DESC,hero->>'uid' LIMIT 1;
  IF v_target_uid IS NULL THEN
    SELECT hero->>'uid' INTO v_target_uid FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero
    ORDER BY (hero->>'position')::integer LIMIT 1;
  END IF;

  v_heavy_casts:=GREATEST(1,FLOOR(COALESCE((v_encounter.room_state->>'elapsed_ms')::numeric,0)/10000)::integer);
  v_identity_casts:=GREATEST(1,FLOOR(COALESCE((v_encounter.room_state->>'elapsed_ms')::numeric,0)/
    CASE v_encounter.room_state->'boss'->>'boss_id'
      WHEN 'iron-warden' THEN 14000 WHEN 'ash-warlock' THEN 12000 WHEN 'thorn-shaman' THEN 16000 ELSE 240000 END)::integer);
  v_identity_ability:=CASE v_encounter.room_state->'boss'->>'boss_id'
    WHEN 'iron-warden' THEN 'Bulwark' WHEN 'ash-warlock' THEN 'Ashen Ruin'
    WHEN 'thorn-shaman' THEN 'Thorn Renewal' WHEN 'rift-behemoth' THEN 'Rift Fury'
    ELSE 'Raise Dead' END;
  v_heavy_damage:=GREATEST(1,ROUND(COALESCE((v_boss->>'atk')::numeric,1)*1.6*v_heavy_casts));

  SELECT jsonb_agg(CASE WHEN hero->>'uid'=v_target_uid AND COALESCE((hero->>'alive')::boolean,false)
    THEN hero||jsonb_build_object(
      'current_hp',GREATEST(1,ROUND((hero->>'current_hp')::numeric-v_heavy_damage)),
      'heavy_damage_taken',v_heavy_damage
    ) ELSE hero END ORDER BY (hero->>'position')::integer) INTO v_heroes
  FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero;

  UPDATE public.dungeon_encounters SET room_state=room_state||jsonb_build_object(
    'heroes',v_heroes,'heavy_target_uid',v_target_uid,'heavy_casts',v_heavy_casts,
    'heavy_warning_ms',3000,'heavy_recovery_ms',7000,'identity_ability',v_identity_ability,
    'identity_casts',v_identity_casts,'telegraph_version','2026.08.13-dungeon-boss-v1'
  ) WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  v_result:=v_result||jsonb_build_object('room_state',v_encounter.room_state);
  UPDATE public.dungeon_events SET result=v_result
  WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id AND action='room_action';
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_shared_boss_basic_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) TO service_role;
