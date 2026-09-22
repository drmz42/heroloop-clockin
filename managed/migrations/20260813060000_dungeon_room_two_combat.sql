ALTER FUNCTION public.dungeon_room_action(uuid, uuid, bigint, text, uuid)
  RENAME TO dungeon_room_one_action;
REVOKE ALL ON FUNCTION public.dungeon_room_one_action(uuid, uuid, bigint, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dungeon_equipment_combat_stat(p_hero jsonb, p_key text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT ROUND(COALESCE(SUM(CASE WHEN stat->>'key' = p_key
    THEN (stat->>'value')::numeric * (1 + LEAST(10, GREATEST(0, (item->>'enchant_level')::integer)) * 0.1)
    ELSE 0 END), 0) * MAX(rarity_set.multiplier), 3)
  FROM jsonb_array_elements(COALESCE(p_hero->'equipment', '[]'::jsonb)) AS equipment(item)
  LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item->'stats') = 'array'
    THEN item->'stats' ELSE '[]'::jsonb END) AS item_stats(stat) ON true
  CROSS JOIN LATERAL (
    SELECT 1 + CASE WHEN jsonb_array_length(COALESCE(p_hero->'equipment', '[]'::jsonb)) = 8
      AND (SELECT count(DISTINCT equipped->>'rarity')
        FROM jsonb_array_elements(p_hero->'equipment') AS all_equipment(equipped)) = 1
      THEN CASE (p_hero->'equipment'->0->>'rarity')
        WHEN 'common' THEN 0.02 WHEN 'uncommon' THEN 0.04 WHEN 'rare' THEN 0.06 WHEN 'epic' THEN 0.08
        WHEN 'legendary' THEN 0.10 WHEN 'mythic' THEN 0.12 WHEN 'cosmic' THEN 0.14
        WHEN 'divine' THEN 0.16 WHEN 'celestial' THEN 0.18 WHEN 'cursed' THEN 0.20
        WHEN 'immortal' THEN 0.22 WHEN 'god' THEN 0.25 ELSE 0 END ELSE 0 END AS multiplier
  ) AS rarity_set
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_two_action(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint,
  p_action_kind text, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id', p_encounter_id,
    'expected_revision', p_expected_revision, 'action_kind', p_action_kind);
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_actor record;
  v_target record;
  v_event_ms numeric := 0;
  v_next_regen_ms numeric := 3000;
  v_next_mark_ms numeric;
  v_mark_impact_ms numeric;
  v_mark_target text;
  v_sequence integer := 0;
  v_damage numeric;
  v_mitigation numeric;
  v_critical numeric;
  v_echo numeric;
  v_deaths integer;
  v_trigger_count integer := 0;
  v_modifier text;
  v_room_status text := 'resolving';
  v_reason text := '';
  v_heroes jsonb;
  v_enemies jsonb;
  v_room_state jsonb;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.dungeon_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'room_action' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN RAISE EXCEPTION 'dungeon_invalid_revision'; END IF;
  IF p_action_kind IS DISTINCT FROM 'resolve' THEN RAISE EXCEPTION 'dungeon_invalid_action'; END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id = p_encounter_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status <> 'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision <> p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room <> 2 OR v_encounter.room_state IS NULL THEN RAISE EXCEPTION 'dungeon_room_not_ready'; END IF;
  IF v_encounter.room_state->>'status' <> 'ready' THEN RAISE EXCEPTION 'dungeon_room_already_resolved'; END IF;
  IF v_encounter.room_state->>'combat_balance_version' <> '2026.08.13-dungeon-room-v1' THEN
    RAISE EXCEPTION 'dungeon_combat_version_mismatch';
  END IF;
  v_modifier := v_encounter.room_state->>'modifier';
  IF v_modifier NOT IN ('stone_skin', 'blood_oath', 'bound_souls', 'mark_of_the_abyss', 'last_fury') THEN
    RAISE EXCEPTION 'dungeon_modifier_invalid';
  END IF;
  v_next_mark_ms := CASE WHEN v_modifier = 'mark_of_the_abyss' THEN 12000 END;

  DROP TABLE IF EXISTS pg_temp.dungeon_pending_damage;
  DROP TABLE IF EXISTS pg_temp.dungeon_sim_units;
  CREATE TEMP TABLE dungeon_sim_units (
    side text NOT NULL, position integer NOT NULL, unit_id text PRIMARY KEY,
    hero_uid text, hero_class text, power numeric NOT NULL DEFAULT 0,
    max_hp numeric NOT NULL, current_hp numeric NOT NULL, atk numeric NOT NULL,
    def numeric NOT NULL, speed numeric NOT NULL, attack_speed numeric NOT NULL,
    crit_chance numeric NOT NULL, crit_damage numeric NOT NULL, dodge numeric NOT NULL,
    def_cap numeric NOT NULL, next_attack_ms numeric NOT NULL, attacks integer NOT NULL DEFAULT 0,
    shield numeric NOT NULL DEFAULT 0, modifier_triggered boolean NOT NULL DEFAULT false,
    death_processed boolean NOT NULL DEFAULT false, alive boolean NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE dungeon_pending_damage(target_id text NOT NULL, amount numeric NOT NULL) ON COMMIT DROP;

  INSERT INTO pg_temp.dungeon_sim_units(side, position, unit_id, hero_uid, hero_class, power,
    max_hp, current_hp, atk, def, speed, attack_speed, crit_chance, crit_damage, dodge,
    def_cap, next_attack_ms, alive)
  SELECT 'hero', (room_hero->>'position')::integer, 'hero:' || (room_hero->>'uid'), room_hero->>'uid',
    split_part(snapshot_hero->>'hero_id', '-', 1), (snapshot_hero->'stats'->>'power')::numeric,
    (room_hero->>'max_hp')::numeric, (room_hero->>'current_hp')::numeric,
    (snapshot_hero->'stats'->>'atk')::numeric, (snapshot_hero->'stats'->>'def')::numeric,
    (snapshot_hero->'stats'->>'speed')::numeric,
    LEAST(0.25, GREATEST(0, COALESCE((snapshot_hero->'stats'->>'attack_speed_bonus')::numeric, 0)
      + CASE split_part(snapshot_hero->>'hero_id', '-', 1) WHEN 'archer' THEN 0.08 ELSE 0 END)),
    LEAST(CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'assassin' THEN 0.60 WHEN 'archer' THEN 0.55 WHEN 'shepherd' THEN 0.50 ELSE 0.45 END,
      CASE split_part(snapshot_hero->>'hero_id', '-', 1)
        WHEN 'knight' THEN 0.08 WHEN 'shepherd' THEN 0.12 WHEN 'assassin' THEN 0.23
        WHEN 'druid' THEN 0.10 ELSE 0.15 END + public.dungeon_equipment_combat_stat(snapshot_hero, 'critChance')),
    LEAST(CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'assassin' THEN 2.50 WHEN 'archer' THEN 2.70 WHEN 'shepherd' THEN 2.30
      WHEN 'druid' THEN 2.10 ELSE 2.00 END,
      CASE split_part(snapshot_hero->>'hero_id', '-', 1)
        WHEN 'knight' THEN 1.60 WHEN 'shepherd' THEN 1.85 WHEN 'assassin' THEN 2.00
        WHEN 'druid' THEN 1.70 ELSE 2.15 END + public.dungeon_equipment_combat_stat(snapshot_hero, 'critDamage')),
    LEAST(CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'assassin' THEN 0.30 WHEN 'archer' THEN 0.20 WHEN 'knight' THEN 0.10 ELSE 0.15 END,
      CASE split_part(snapshot_hero->>'hero_id', '-', 1) WHEN 'assassin' THEN 0.05 ELSE 0 END
        + public.dungeon_equipment_combat_stat(snapshot_hero, 'dodge')),
    CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'knight' THEN 0.60 WHEN 'druid' THEN 0.50 WHEN 'archer' THEN 0.45 ELSE 0.40 END,
    public.dungeon_combat_roll(v_encounter.seed, 2, 0, room_hero->>'uid', 'initial')
      * public.dungeon_attack_interval_ms((snapshot_hero->'stats'->>'speed')::numeric,
        LEAST(0.25, GREATEST(0, COALESCE((snapshot_hero->'stats'->>'attack_speed_bonus')::numeric, 0)
          + CASE split_part(snapshot_hero->>'hero_id', '-', 1) WHEN 'archer' THEN 0.08 ELSE 0 END))),
    COALESCE((room_hero->>'alive')::boolean, false)
  FROM jsonb_array_elements(v_encounter.room_state->'heroes') AS room_heroes(room_hero)
  JOIN LATERAL (SELECT hero AS snapshot_hero FROM jsonb_array_elements(v_encounter.roster_snapshot) AS roster(hero)
    WHERE hero->>'uid' = room_hero->>'uid' LIMIT 1) AS snapshot ON true;

  INSERT INTO pg_temp.dungeon_sim_units(side, position, unit_id, max_hp, current_hp, atk, def,
    speed, attack_speed, crit_chance, crit_damage, dodge, def_cap, next_attack_ms, shield,
    modifier_triggered, alive)
  SELECT 'enemy', (enemy->>'lane')::integer, enemy->>'unit_id', (enemy->>'max_hp')::numeric,
    (enemy->>'current_hp')::numeric, (enemy->>'atk')::numeric, (enemy->>'def')::numeric,
    (enemy->>'speed')::numeric, COALESCE((enemy->>'attack_speed_bonus')::numeric, 0),
    0.06, 1.50, 0, 0.50,
    public.dungeon_combat_roll(v_encounter.seed, 2, 0, enemy->>'unit_id', 'initial')
      * public.dungeon_attack_interval_ms((enemy->>'speed')::numeric,
        COALESCE((enemy->>'attack_speed_bonus')::numeric, 0)),
    COALESCE((enemy->>'shield')::numeric, 0), COALESCE((enemy->>'modifier_triggered')::boolean, false),
    COALESCE((enemy->>'alive')::boolean, false)
  FROM jsonb_array_elements(v_encounter.room_state->'enemies') AS enemies(enemy);

  IF (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = 'hero')
      <> jsonb_array_length(v_encounter.roster_snapshot)
    OR (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = 'enemy')
      <> (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = 'hero' AND alive) THEN
    RAISE EXCEPTION 'dungeon_room_state_invalid';
  END IF;

  WHILE EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side = 'hero' AND alive)
    AND EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side = 'enemy' AND alive)
  LOOP
    SELECT MIN(moment) INTO v_event_ms FROM (VALUES
      ((SELECT MIN(next_attack_ms) FROM pg_temp.dungeon_sim_units WHERE alive)),
      (v_next_regen_ms), (v_next_mark_ms), (v_mark_impact_ms)
    ) AS moments(moment) WHERE moment IS NOT NULL;
    IF v_event_ms IS NULL OR v_event_ms > 120000 OR v_sequence >= 1200 THEN
      v_room_status := 'failed'; v_reason := 'timeout'; EXIT;
    END IF;
    v_sequence := v_sequence + 1;

    IF v_event_ms = v_next_regen_ms THEN
      IF EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='hero' AND hero_class='druid' AND alive) THEN
        UPDATE pg_temp.dungeon_sim_units SET current_hp=LEAST(max_hp,current_hp+max_hp*0.012)
        WHERE side='hero' AND alive;
      END IF;
      v_next_regen_ms := v_next_regen_ms + 3000;
    END IF;
    IF v_event_ms = v_next_mark_ms THEN
      SELECT unit_id INTO v_mark_target FROM pg_temp.dungeon_sim_units
      WHERE side='hero' AND alive ORDER BY power DESC, position, unit_id LIMIT 1;
      v_mark_impact_ms := v_event_ms + 2000;
      v_next_mark_ms := v_next_mark_ms + 12000;
      v_trigger_count := v_trigger_count + 1;
    END IF;

    TRUNCATE pg_temp.dungeon_pending_damage;
    FOR v_actor IN SELECT * FROM pg_temp.dungeon_sim_units
      WHERE alive AND next_attack_ms = v_event_ms ORDER BY side, position, unit_id
    LOOP
      IF v_actor.side='hero' THEN
        SELECT * INTO v_target FROM pg_temp.dungeon_sim_units
        WHERE side='enemy' AND position=v_actor.position AND alive LIMIT 1;
        IF NOT FOUND THEN SELECT * INTO v_target FROM pg_temp.dungeon_sim_units WHERE side='enemy' AND alive
          ORDER BY current_hp/NULLIF(max_hp,0),position,unit_id LIMIT 1; END IF;
      ELSE
        SELECT * INTO v_target FROM pg_temp.dungeon_sim_units
        WHERE side='hero' AND position=v_actor.position AND alive LIMIT 1;
        IF NOT FOUND THEN SELECT * INTO v_target FROM pg_temp.dungeon_sim_units WHERE side='hero' AND alive
          ORDER BY current_hp/NULLIF(max_hp,0) DESC,position,unit_id LIMIT 1; END IF;
      END IF;
      IF FOUND AND public.dungeon_combat_roll(v_encounter.seed,2,v_sequence,v_actor.unit_id,'dodge') >= v_target.dodge THEN
        v_mitigation:=LEAST(v_target.def_cap,v_target.def/NULLIF(v_target.def+2*v_actor.atk,0));
        v_critical:=CASE WHEN public.dungeon_combat_roll(v_encounter.seed,2,v_sequence,v_actor.unit_id,'critical') < v_actor.crit_chance THEN v_actor.crit_damage ELSE 1 END;
        v_echo:=CASE WHEN v_actor.hero_class='shepherd' AND (v_actor.attacks+1)%5=0 THEN 1.5 ELSE 1 END;
        v_damage:=GREATEST(1,ROUND(v_actor.atk*(1-v_mitigation)*v_critical*v_echo
          *(0.9+public.dungeon_combat_roll(v_encounter.seed,2,v_sequence,v_actor.unit_id,'variance')*0.2)));
        INSERT INTO pg_temp.dungeon_pending_damage VALUES(v_target.unit_id,v_damage);
      END IF;
      UPDATE pg_temp.dungeon_sim_units SET attacks=attacks+1,
        next_attack_ms=next_attack_ms+public.dungeon_attack_interval_ms(speed,attack_speed)
      WHERE unit_id=v_actor.unit_id;
    END LOOP;

    IF v_event_ms = v_mark_impact_ms THEN
      SELECT * INTO v_target FROM pg_temp.dungeon_sim_units WHERE unit_id=v_mark_target AND alive;
      IF FOUND THEN
        SELECT COALESCE(MAX(atk),0) INTO v_damage FROM pg_temp.dungeon_sim_units WHERE side='enemy' AND alive;
        v_mitigation:=LEAST(v_target.def_cap,v_target.def/NULLIF(v_target.def+2*v_damage,0));
        v_damage:=GREATEST(1,ROUND(v_damage*(1-v_mitigation)
          *(0.9+public.dungeon_combat_roll(v_encounter.seed,2,v_sequence,v_mark_target,'mark')*0.2)));
        INSERT INTO pg_temp.dungeon_pending_damage VALUES(v_mark_target,v_damage);
      END IF;
      v_mark_impact_ms := NULL; v_mark_target := NULL;
    END IF;

    UPDATE pg_temp.dungeon_sim_units AS unit SET
      current_hp=GREATEST(0,unit.current_hp-GREATEST(0,pending.amount-unit.shield)),
      shield=GREATEST(0,unit.shield-pending.amount),
      alive=unit.current_hp-GREATEST(0,pending.amount-unit.shield)>0
    FROM (SELECT target_id,SUM(amount) amount FROM pg_temp.dungeon_pending_damage GROUP BY target_id) pending
    WHERE unit.unit_id=pending.target_id;

    SELECT count(*) INTO v_deaths FROM pg_temp.dungeon_sim_units
    WHERE side='enemy' AND NOT alive AND NOT death_processed;
    IF v_deaths > 0 THEN
      IF v_modifier='blood_oath' AND v_trigger_count=0 THEN
        UPDATE pg_temp.dungeon_sim_units SET atk=atk*1.20, modifier_triggered=true
        WHERE side='enemy' AND alive;
        v_trigger_count:=1;
      ELSIF v_modifier='bound_souls' THEN
        UPDATE pg_temp.dungeon_sim_units SET shield=GREATEST(shield,max_hp*0.15)
        WHERE side='enemy' AND alive;
        v_trigger_count:=v_trigger_count+v_deaths;
      END IF;
      UPDATE pg_temp.dungeon_sim_units SET death_processed=true
      WHERE side='enemy' AND NOT alive AND NOT death_processed;
    END IF;
    IF v_modifier='last_fury' THEN
      UPDATE pg_temp.dungeon_sim_units SET attack_speed=0.15,modifier_triggered=true
      WHERE side='enemy' AND alive AND NOT modifier_triggered AND current_hp/max_hp<0.35;
      GET DIAGNOSTICS v_deaths = ROW_COUNT;
      v_trigger_count:=v_trigger_count+v_deaths;
    END IF;
  END LOOP;

  IF v_room_status <> 'failed' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='hero' AND alive) THEN
      v_room_status:='failed'; v_reason:='party_defeated';
    ELSIF EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='enemy' AND alive) THEN
      v_room_status:='failed'; v_reason:='timeout';
    ELSE v_room_status:='cleared'; v_reason:='elite_guards_defeated'; END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('position',position,'uid',hero_uid,
    'hero_id',(SELECT hero->>'hero_id' FROM jsonb_array_elements(v_encounter.roster_snapshot) roster(hero)
      WHERE hero->>'uid'=hero_uid LIMIT 1),'max_hp',max_hp,'current_hp',ROUND(current_hp),
    'alive',alive,'attacks',attacks) ORDER BY position) INTO v_heroes
  FROM pg_temp.dungeon_sim_units WHERE side='hero';
  SELECT jsonb_agg(jsonb_build_object('unit_id',unit_id,'lane',position,'max_hp',max_hp,
    'current_hp',ROUND(current_hp),'atk',ROUND(atk,3),'def',def,'speed',speed,
    'attack_speed_bonus',attack_speed,'shield',ROUND(shield),'alive',alive,'attacks',attacks,
    'modifier_triggered',modifier_triggered) ORDER BY position) INTO v_enemies
  FROM pg_temp.dungeon_sim_units WHERE side='enemy';

  v_room_state:=v_encounter.room_state||jsonb_build_object('status',v_room_status,
    'sequence',v_sequence,'elapsed_ms',LEAST(120000,ROUND(v_event_ms)),'heroes',v_heroes,
    'enemies',v_enemies,'modifier_state',jsonb_build_object('trigger_count',v_trigger_count,
      'next_mark_ms',v_next_mark_ms),'resolution',jsonb_build_object('reason',v_reason,'resolved_at',now()));
  UPDATE public.dungeon_encounters SET room_state=v_room_state,revision=revision+1
  WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'room',v_encounter.room,
    'revision',v_encounter.revision,'room_state',v_encounter.room_state);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_action',v_request,v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_action(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint,
  p_action_kind text, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_room integer;
BEGIN
  SELECT COALESCE((result->>'room')::integer, 0) INTO v_room
  FROM public.dungeon_events WHERE idempotency_key=p_idempotency_key AND action='room_action';
  IF COALESCE(v_room,0)=0 THEN
    SELECT room INTO v_room FROM public.dungeon_encounters
    WHERE id=p_encounter_id AND player_id=p_player_id;
  END IF;
  IF v_room=2 THEN
    RETURN public.dungeon_room_two_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  END IF;
  RETURN public.dungeon_room_one_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
END;
$$;

CREATE OR REPLACE FUNCTION public.dungeon_room_complete(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb:=jsonb_build_object('encounter_id',p_encounter_id,'expected_revision',p_expected_revision);
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_run_state jsonb; v_result jsonb; v_outcome text; v_rooms_cleared integer;
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
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id=p_encounter_id AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dungeon_encounter_not_found'; END IF;
  IF v_encounter.status<>'active' THEN RAISE EXCEPTION 'dungeon_encounter_not_active'; END IF;
  IF v_encounter.revision<>p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room NOT IN (1,2) OR v_encounter.room_state IS NULL THEN RAISE EXCEPTION 'dungeon_room_not_ready'; END IF;
  v_outcome:=v_encounter.room_state->>'status';
  IF v_outcome NOT IN ('cleared','failed') THEN RAISE EXCEPTION 'dungeon_room_not_resolved'; END IF;
  IF jsonb_typeof(v_encounter.room_state->'heroes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'dungeon_room_state_invalid'; END IF;
  v_rooms_cleared:=CASE WHEN v_outcome='cleared' THEN v_encounter.room ELSE v_encounter.room-1 END;
  v_run_state:=jsonb_build_object('heroes',v_encounter.room_state->'heroes','rooms_cleared',v_rooms_cleared);
  IF v_outcome='cleared' THEN
    UPDATE public.dungeon_encounters SET run_state=v_run_state,room=room+1,room_state=NULL,
      room_started_at=NULL,revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  ELSE
    UPDATE public.dungeon_encounters SET run_state=v_run_state,status='failed',revision=revision+1,
      completed_at=now() WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  END IF;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'status',v_encounter.status,'room',v_encounter.room,
    'revision',v_encounter.revision,'run_state',v_encounter.run_state,'room_state',v_encounter.room_state,
    'attempt_refunded',false);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_complete',v_request,v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_equipment_combat_stat(jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_two_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dungeon_room_action(uuid,uuid,bigint,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_room_complete(uuid,uuid,bigint,uuid) TO service_role;
