-- Separate, stock-only premium healing. Ordinary automatic healing is unchanged.
INSERT INTO public.resource_catalog(resource_id,family,display_order,maximum_balance)
VALUES ('premium_potion_weak','potion',14,1000000000),
       ('premium_potion_strong','potion',15,1000000000)
ON CONFLICT (resource_id) DO NOTHING;
INSERT INTO public.player_resource_balances(player_id,resource_id)
SELECT player_id,resource_id FROM public.player_resource_state
CROSS JOIN public.resource_catalog WHERE resource_id IN ('premium_potion_weak','premium_potion_strong')
ON CONFLICT DO NOTHING;

-- Opening balances already enumerate the catalogue for future registrations.
DO $patch$
DECLARE d text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)',
    'public.resource_ledger_reconciliation()'] LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    IF position('premium_potion_brew' in d)=0 THEN
      IF position('''potion_use''' in d)=0 THEN RAISE EXCEPTION 'premium_resource_definition_mismatch'; END IF;
      d:=replace(d,'''potion_use''','''potion_use'',''premium_potion_brew'',''premium_potion_merge'',''premium_potion_use'',''premium_potion_reward''');
      EXECUTE d;
    END IF;
  END LOOP;
END $patch$;

CREATE OR REPLACE FUNCTION public.premium_potion_minor_reserved(p_player_id uuid)
RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $fn$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM public.normal_combat_events WHERE player_id=p_player_id AND completed_at IS NULL AND outcome IS NULL)
    THEN 1000000000 ELSE (SELECT count(*) FROM public.normal_combat_events wave
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(wave.outcome->'auto_potions','[]'::jsonb)) event
      WHERE wave.player_id=p_player_id AND wave.completed_at IS NULL AND event->>'tier'='xs' AND event->>'from_stock'='true') END
$fn$;

CREATE OR REPLACE FUNCTION heroloop_api.premium_potion_status(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT jsonb_build_object('weak',COALESCE((r#>>'{balances,premium_potion_weak}')::bigint,0)::text,
    'strong',COALESCE((r#>>'{balances,premium_potion_strong}')::bigint,0)::text,
    'minor',GREATEST(0,COALESCE((r#>>'{balances,potion_xs}')::bigint,0)-public.premium_potion_minor_reserved(p_player_id))::text,
    'version','premium-potions-v1') FROM (SELECT public.resource_snapshot(p_player_id) r) snapshot
$fn$;

CREATE OR REPLACE FUNCTION heroloop_api.premium_potion_upgrade(p_player_id uuid,p_recipe text,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE s public.player_saves; prior public.resource_transactions; entries jsonb; r jsonb; v_result jsonb;
  h text:=encode(extensions.digest(jsonb_build_object('recipe',p_recipe)::text,'sha256'),'hex');
BEGIN
  IF p_recipe NOT IN ('brew','merge') OR p_recipe IS NULL OR p_key IS NULL THEN RAISE EXCEPTION 'invalid_premium_potion'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('normal-combat:'||p_player_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:'||p_player_id::text,0));
  SELECT * INTO s FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT * INTO prior FROM public.resource_transactions WHERE player_id=p_player_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.action<>'premium_potion_'||p_recipe OR prior.request_hash<>h THEN RAISE EXCEPTION 'resource_idempotency_conflict'; END IF;
    RETURN prior.result;
  END IF;
  IF p_recipe='brew' AND (heroloop_api.premium_potion_status(p_player_id)->>'minor')::bigint<2 THEN
    RAISE EXCEPTION 'premium_potion_reserved_stock';
  END IF;
  entries:=jsonb_build_array(
    jsonb_build_object('resource_id',CASE p_recipe WHEN 'brew' THEN 'potion_xs' ELSE 'premium_potion_weak' END,
      'delta','-2','source_key','premium_potion_'||p_recipe),
    jsonb_build_object('resource_id',CASE p_recipe WHEN 'brew' THEN 'premium_potion_weak' ELSE 'premium_potion_strong' END,
      'delta','1','source_key','premium_potion_'||p_recipe));
  r:=public.apply_resource_entries(p_player_id,p_key,'premium_potion_'||p_recipe,h,entries,s.revision+1);
  UPDATE public.player_saves SET state=jsonb_set(state,'{potions,xs}',to_jsonb((r#>>'{balances,potion_xs}')::bigint),true),
    revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING * INTO s;
  v_result:=r||jsonb_build_object('stock',heroloop_api.premium_potion_status(p_player_id),'state',s.state,'revision',s.revision);
  UPDATE public.resource_transactions SET result=result||jsonb_build_object('stock',heroloop_api.premium_potion_status(p_player_id),
    'state',s.state,'revision',s.revision) WHERE player_id=p_player_id AND idempotency_key=p_key;
  RETURN v_result;
END $fn$;

-- Resolver hook uses only the server-validated plan and server-owned HP.
CREATE OR REPLACE FUNCTION public.premium_potion_tick(p_plan jsonb,p_elapsed numeric)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
DECLARE u record; n integer:=CASE p_plan->>'tier' WHEN 'weak' THEN 4 ELSE 6 END;
  total integer:=CASE p_plan->>'tier' WHEN 'weak' THEN 200 ELSE 500 END;
  tick integer:=(p_elapsed-(p_plan->>'delay_ms')::integer)::integer/5000;
  amount numeric;
BEGIN
  SELECT * INTO u FROM pg_temp.dungeon_sim_units WHERE side='hero' AND hero_uid=p_plan->>'hero_uid' AND alive;
  IF NOT FOUND THEN RETURN; END IF;
  amount:=LEAST(u.max_hp-u.current_hp,floor(tick*total::numeric/n)-floor((tick-1)*total::numeric/n));
  IF amount<=0 THEN RETURN; END IF;
  UPDATE pg_temp.dungeon_sim_units SET current_hp=current_hp+amount WHERE unit_id=u.unit_id;
  INSERT INTO pg_temp.premium_potion_events(elapsed_ms,hero_uid,amount,hp_after)
  VALUES(p_elapsed,u.hero_uid,amount,u.current_hp+amount);
END $fn$;

-- Extend only the Retinue and shared-Boss resolvers, including both frozen versions.
-- Old encounters without a premium plan follow their original event clock.
DO $patch$
DECLARE signature text; d text; marker text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.dungeon_room_four_retinue_action(uuid,uuid,bigint,text,uuid)',
    'public.dungeon_shared_boss_basic_action(uuid,uuid,bigint,text,uuid)',
    'public.dungeon_shared_boss_v2_basic_action(uuid,uuid,bigint,text,uuid)']
  LOOP
    d:=pg_get_functiondef(signature::regprocedure);
    IF position('v_next_premium_ms' in d)>0 THEN CONTINUE; END IF;
    IF position('v_event_ms numeric := 0;' in d)=0 OR position('SELECT LEAST(' in d)=0
      OR position('v_sequence := v_sequence + 1;' in d)=0 THEN RAISE EXCEPTION 'premium_resolver_definition_mismatch: %',signature; END IF;
    d:=replace(d,'v_event_ms numeric := 0;',E'v_event_ms numeric := 0;\n  v_next_premium_ms numeric := 1000000000;\n  v_premium_ticks integer := 0;');
    marker:='  WHILE EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units';
    IF position(marker in d)=0 THEN RAISE EXCEPTION 'premium_loop_definition_mismatch'; END IF;
    d:=replace(d,marker,E'  CREATE TEMP TABLE premium_potion_events (elapsed_ms numeric,hero_uid text,amount numeric,hp_after numeric) ON COMMIT DROP;\n  IF v_encounter.room_state->''premium_potion'' IS NOT NULL THEN\n    v_next_premium_ms := (v_encounter.room_state#>>''{premium_potion,delay_ms}'')::integer + 5000;\n  END IF;\n'||marker);
    d:=replace(d,'SELECT LEAST(','SELECT LEAST(v_next_premium_ms,');
    d:=replace(d,'v_sequence := v_sequence + 1;',E'v_sequence := v_sequence + 1;\n    IF v_event_ms = v_next_premium_ms THEN\n      PERFORM public.premium_potion_tick(v_encounter.room_state->''premium_potion'',v_event_ms);\n      v_premium_ticks := v_premium_ticks + 1;\n      v_next_premium_ms := CASE WHEN v_premium_ticks < CASE v_encounter.room_state#>>''{premium_potion,tier}'' WHEN ''weak'' THEN 4 ELSE 6 END THEN v_next_premium_ms+5000 ELSE 1000000000 END;\n    END IF;');
    -- Both formatting variants are explicitly covered by the fixture.
    IF position('  v_room_state := v_encounter.room_state' in d)>0 THEN
      marker:='  v_room_state := v_encounter.room_state';
    ELSE marker:='  v_room_state:=v_encounter.room_state'; END IF;
    IF position(marker in d)=0 THEN RAISE EXCEPTION 'premium_result_definition_mismatch'; END IF;
    d:=replace(d,marker,E'  v_encounter.room_state := v_encounter.room_state || jsonb_build_object(''premium_potion_events'',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY elapsed_ms),''[]''::jsonb) FROM pg_temp.premium_potion_events e));\n'||marker);
    EXECUTE d;
  END LOOP;
END $patch$;

CREATE OR REPLACE FUNCTION heroloop_api.premium_potion_use(
  p_player_id uuid,p_encounter uuid,p_revision bigint,p_tier text,p_hero text,p_delay integer,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE e public.dungeon_encounters; s public.player_saves; prior public.resource_transactions;
  r jsonb; resolved jsonb; v_result jsonb;
  h text:=encode(extensions.digest(jsonb_build_object('encounter',p_encounter,'revision',p_revision,
    'tier',p_tier,'hero',p_hero,'delay',p_delay)::text,'sha256'),'hex');
BEGIN
  IF p_tier IS NULL OR p_tier NOT IN ('weak','strong') OR p_delay IS NULL OR p_delay NOT IN (0,5000,10000)
    OR p_revision IS NULL OR p_revision<1 OR p_key IS NULL OR p_hero IS NULL THEN RAISE EXCEPTION 'invalid_premium_potion'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:'||p_player_id::text,0));
  SELECT * INTO prior FROM public.resource_transactions WHERE player_id=p_player_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.action<>'premium_potion_use' OR prior.request_hash<>h THEN RAISE EXCEPTION 'resource_idempotency_conflict'; END IF;
    RETURN prior.result;
  END IF;
  SELECT * INTO e FROM public.dungeon_encounters WHERE id=p_encounter AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR e.status<>'active' OR e.room<>4 OR e.room_state->>'status' IS DISTINCT FROM 'ready'
    OR e.room_state->>'kind' NOT IN ('retinue','shared_boss') THEN RAISE EXCEPTION 'premium_encounter_not_ready'; END IF;
  IF e.revision<>p_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.room_state->'heroes') hero
    WHERE hero->>'uid'=p_hero AND (hero->>'alive')::boolean AND (hero->>'current_hp')::numeric>0)
    THEN RAISE EXCEPTION 'premium_invalid_target'; END IF;
  SELECT * INTO s FROM public.player_saves WHERE player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  r:=public.apply_resource_entries(p_player_id,p_key,'premium_potion_use',h,
    jsonb_build_array(jsonb_build_object('resource_id','premium_potion_'||p_tier,'delta','-1','source_key','premium_potion_use')),s.revision+1);
  UPDATE public.dungeon_encounters SET room_state=room_state||jsonb_build_object('premium_potion',
    jsonb_build_object('tier',p_tier,'hero_uid',p_hero,'delay_ms',p_delay,'version','premium-potions-v1')) WHERE id=e.id;
  resolved:=public.dungeon_room_action(p_player_id,p_encounter,p_revision,'resolve',p_key);
  UPDATE public.player_saves SET revision=revision+1,updated_at=now() WHERE player_id=p_player_id RETURNING * INTO s;
  v_result:=r||resolved||jsonb_build_object('stock',heroloop_api.premium_potion_status(p_player_id),'state',s.state,'save_revision',s.revision);
  UPDATE public.resource_transactions SET result=result||resolved||jsonb_build_object('stock',heroloop_api.premium_potion_status(p_player_id),
    'state',s.state,'save_revision',s.revision) WHERE player_id=p_player_id AND idempotency_key=p_key;
  RETURN v_result;
END $fn$;

-- Seeker Boss rewards include one Weak Premium, atomically with the existing claim.
-- An old claim replay is never retroactively rewarded.
CREATE OR REPLACE FUNCTION heroloop_api.premium_boss_claim(
  p_player_id uuid,p_encounter_id uuid,p_expected_revision bigint,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE prior public.boss_claim_events; r jsonb; receipt jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:'||p_player_id::text,0));
  SELECT * INTO prior FROM public.boss_claim_events WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    -- The canonical claim validates replay ownership and all bound request fields.
    RETURN public.boss_claim(p_player_id,p_encounter_id,p_expected_revision,p_idempotency_key);
  END IF;
  r:=public.boss_claim(p_player_id,p_encounter_id,p_expected_revision,p_idempotency_key);
  receipt:=public.apply_resource_entries(p_player_id,p_idempotency_key,'premium_potion_reward',
    encode(extensions.digest(jsonb_build_object('encounter_id',p_encounter_id)::text,'sha256'),'hex'),
    '[{"resource_id":"premium_potion_weak","delta":"1","source_key":"premium_potion_reward"}]',
    (r->>'save_revision')::bigint);
  r:=r||jsonb_build_object('premium_potions_awarded',1,'stock',heroloop_api.premium_potion_status(p_player_id));
  UPDATE public.boss_claim_events SET result=r WHERE idempotency_key=p_idempotency_key;
  UPDATE public.resource_transactions SET result=result||jsonb_build_object('claim',r)
    WHERE player_id=p_player_id AND idempotency_key=p_idempotency_key;
  RETURN r;
END $fn$;

REVOKE ALL ON FUNCTION public.premium_potion_tick(jsonb,numeric) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.premium_potion_minor_reserved(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION heroloop_api.premium_potion_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.premium_potion_upgrade(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.premium_potion_use(uuid,uuid,bigint,text,text,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.premium_boss_claim(uuid,uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.premium_potion_status(uuid),heroloop_api.premium_potion_upgrade(uuid,text,uuid),
  heroloop_api.premium_potion_use(uuid,uuid,bigint,text,text,integer,uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.premium_boss_claim(uuid,uuid,bigint,uuid) TO heroloop_api;
