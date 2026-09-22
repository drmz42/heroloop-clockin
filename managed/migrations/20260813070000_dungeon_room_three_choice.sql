CREATE OR REPLACE FUNCTION public.dungeon_room_three_treasure_enemies(p_depth integer, p_heroes jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'unit_id', 'treasure-guard-' || (hero->>'position'), 'lane', (hero->>'position')::integer,
    'max_hp', CASE p_depth WHEN 1 THEN 216 WHEN 2 THEN 830 WHEN 3 THEN 2366 END,
    'current_hp', CASE p_depth WHEN 1 THEN 216 WHEN 2 THEN 830 WHEN 3 THEN 2366 END,
    'atk', CASE p_depth WHEN 1 THEN 20 WHEN 2 THEN 75 WHEN 3 THEN 205 END,
    'def', CASE p_depth WHEN 1 THEN 7 WHEN 2 THEN 27 WHEN 3 THEN 95 END,
    'speed', CASE p_depth WHEN 1 THEN 99.630 WHEN 2 THEN 102.888 WHEN 3 THEN 102.888 END,
    'alive', true) ORDER BY (hero->>'position')::integer), '[]'::jsonb)
  FROM jsonb_array_elements(p_heroes) heroes(hero)
  WHERE COALESCE((hero->>'alive')::boolean, false)
$$;

ALTER TABLE public.dungeon_events DROP CONSTRAINT dungeon_events_action_check;
ALTER TABLE public.dungeon_events ADD CONSTRAINT dungeon_events_action_check
  CHECK (action IN ('start','room_start','room_action','room_complete','room_choice','abandon'));

CREATE OR REPLACE FUNCTION public.dungeon_room_choose(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_choice text, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id',p_encounter_id,'expected_revision',p_expected_revision,'choice',p_choice);
  v_encounter public.dungeon_encounters%ROWTYPE; v_heroes jsonb; v_room_state jsonb; v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:'||p_player_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id<>p_player_id OR v_existing.action<>'room_choice' OR v_existing.request<>v_request THEN
      RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'dungeon_invalid_revision'; END IF;
  IF p_choice NOT IN ('recovery','treasure') THEN RAISE EXCEPTION 'dungeon_invalid_choice'; END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id=p_encounter_id AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status<>'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision<>p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room<>3 OR v_encounter.room_state IS NOT NULL
    OR COALESCE((v_encounter.run_state->>'rooms_cleared')::integer,0)<>2 THEN
    RAISE EXCEPTION 'dungeon_room_not_ready'; END IF;
  IF jsonb_typeof(v_encounter.run_state->'heroes') IS DISTINCT FROM 'array'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_encounter.run_state->'heroes') heroes(hero)
      WHERE COALESCE((hero->>'alive')::boolean,false)) THEN RAISE EXCEPTION 'dungeon_run_state_invalid'; END IF;

  SELECT jsonb_agg(CASE WHEN COALESCE((hero->>'alive')::boolean,false) THEN
    hero||jsonb_build_object('current_hp',LEAST((hero->>'max_hp')::numeric,
      (hero->>'current_hp')::numeric+(hero->>'max_hp')::numeric*0.25),'alive',true)
    ELSE hero END ORDER BY (hero->>'position')::integer)
  INTO v_heroes FROM jsonb_array_elements(v_encounter.run_state->'heroes') heroes(hero);

  IF p_choice='recovery' THEN
    v_room_state:=jsonb_build_object('room',3,'kind','recovery','choice','recovery','status','cleared',
      'combat_balance_version','2026.08.13-dungeon-room-v1','heroes',v_heroes,'enemies','[]'::jsonb,
      'resolution',jsonb_build_object('reason','recovery_applied','resolved_at',now()));
  ELSE
    v_heroes:=v_encounter.run_state->'heroes';
    v_room_state:=jsonb_build_object('room',3,'kind','treasure_guards','choice','treasure','status','ready',
      'sequence',0,'max_seconds',120,'combat_balance_version','2026.08.13-dungeon-room-v1',
      'heroes',v_heroes,'enemies',public.dungeon_room_three_treasure_enemies(v_encounter.depth,v_heroes));
  END IF;
  UPDATE public.dungeon_encounters SET room_state=v_room_state,room_started_at=now(),revision=revision+1
  WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'room',v_encounter.room,'revision',v_encounter.revision,
    'run_state',v_encounter.run_state,'room_state',v_encounter.room_state);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_choice',v_request,v_result);
  RETURN v_result;
END;
$$;

DO $$
DECLARE v_signature regprocedure:='public.dungeon_room_complete(uuid,uuid,bigint,uuid)'::regprocedure;
  v_definition text:=pg_get_functiondef(v_signature);
BEGIN
  IF (length(v_definition)-length(replace(v_definition,'v_encounter.room NOT IN (1,2)','')))
    /length('v_encounter.room NOT IN (1,2)')<>1 THEN RAISE EXCEPTION 'dungeon_room_complete_definition_mismatch'; END IF;
  EXECUTE replace(v_definition,'v_encounter.room NOT IN (1,2)','v_encounter.room NOT IN (1,2,3)');
END $$;

REVOKE ALL ON FUNCTION public.dungeon_room_three_treasure_enemies(integer,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_choose(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_choose(uuid,uuid,bigint,text,uuid) TO service_role;
