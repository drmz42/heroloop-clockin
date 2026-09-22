BEGIN;

CREATE OR REPLACE FUNCTION public.dungeon_combat_effects_version_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_requested text := nullif(current_setting('heroloop.dungeon_combat_effects_version', true), '');
BEGIN
  IF v_requested IS NULL OR v_requested = 'combat-effects-v1' THEN
    RETURN NEW;
  END IF;
  IF v_requested <> 'combat-effects-v2-team-contributions-candidate-2026.09.06-v1' THEN
    RAISE EXCEPTION 'dungeon_combat_effects_version_invalid';
  END IF;
  NEW.balance_version := '2026.09.06-shared-boss-effects-v2-candidate';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dungeon_combat_effects_version_gate ON public.dungeon_encounters;
CREATE TRIGGER dungeon_combat_effects_version_gate
BEFORE INSERT ON public.dungeon_encounters
FOR EACH ROW EXECUTE FUNCTION public.dungeon_combat_effects_version_gate();

CREATE OR REPLACE FUNCTION public.dungeon_shared_boss_version_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.balance_version = '2026.09.06-shared-boss-effects-v2-candidate'
    AND NEW.room_state->>'kind' = 'shared_boss' THEN
    NEW.room_state := jsonb_set(
      NEW.room_state,
      '{combat_balance_version}',
      to_jsonb('2026.09.06-shared-boss-effects-v2-candidate'::text),
      true
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dungeon_shared_boss_version_gate ON public.dungeon_encounters;
CREATE TRIGGER dungeon_shared_boss_version_gate
BEFORE UPDATE OF room_state ON public.dungeon_encounters
FOR EACH ROW EXECUTE FUNCTION public.dungeon_shared_boss_version_gate();

CREATE OR REPLACE FUNCTION public.dungeon_shared_boss_v2_basic_action(
  p_player_id uuid,
  p_encounter_id uuid,
  p_expected_revision bigint,
  p_action_kind text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.dungeon_events%ROWTYPE;
  v_request jsonb := jsonb_build_object(
    'encounter_id', p_encounter_id,
    'expected_revision', p_expected_revision,
    'action_kind', p_action_kind
  );
  v_encounter public.dungeon_encounters%ROWTYPE;
  v_actor record;
  v_target record;
  v_knight record;
  v_aegis_target record;
  v_event_ms numeric := 0;
  v_next_regen_ms numeric := 3000;
  v_next_aegis_ms numeric := 10000;
  v_sequence integer := 0;
  v_damage numeric;
  v_echo_damage numeric;
  v_mitigation numeric;
  v_critical numeric;
  v_mark_multiplier numeric;
  v_aegis_amount numeric;
  v_room_status text := 'resolving';
  v_reason text := '';
  v_heroes jsonb;
  v_enemies jsonb;
  v_effect_events jsonb;
  v_room_state jsonb;
  v_result jsonb;
  v_druid_uid text;
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
  IF v_encounter.balance_version <> '2026.09.06-shared-boss-effects-v2-candidate'
    OR v_encounter.room <> 4 OR v_encounter.room_state IS NULL
    OR v_encounter.room_state->>'kind' <> 'shared_boss' THEN
    RAISE EXCEPTION 'dungeon_room_not_ready';
  END IF;
  IF v_encounter.room_state->>'status' <> 'ready' THEN RAISE EXCEPTION 'dungeon_room_already_resolved'; END IF;
  IF v_encounter.room_state->>'combat_balance_version' <> '2026.09.06-shared-boss-effects-v2-candidate' THEN
    RAISE EXCEPTION 'dungeon_combat_version_mismatch';
  END IF;

  DROP TABLE IF EXISTS pg_temp.dungeon_sim_units, pg_temp.dungeon_pending_damage, pg_temp.dungeon_v2_effect_events;
  CREATE TEMP TABLE dungeon_sim_units (
    side text NOT NULL,
    position integer NOT NULL,
    unit_id text PRIMARY KEY,
    hero_uid text,
    hero_class text,
    max_hp numeric NOT NULL,
    current_hp numeric NOT NULL,
    atk numeric NOT NULL,
    def numeric NOT NULL,
    speed numeric NOT NULL,
    attack_speed numeric NOT NULL,
    crit_chance numeric NOT NULL,
    crit_damage numeric NOT NULL,
    dodge numeric NOT NULL,
    def_cap numeric NOT NULL,
    next_attack_ms numeric NOT NULL,
    attacks integer NOT NULL DEFAULT 0,
    landed_hits integer NOT NULL DEFAULT 0,
    expose_ready_ms numeric NOT NULL DEFAULT 0,
    barrier_amount numeric NOT NULL DEFAULT 0,
    barrier_until_ms numeric NOT NULL DEFAULT 0,
    mark_source_id text,
    mark_until_ms numeric NOT NULL DEFAULT 0,
    expose_source_id text,
    expose_until_ms numeric NOT NULL DEFAULT 0,
    suppression_until_ms numeric NOT NULL DEFAULT 0,
    alive boolean NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE dungeon_pending_damage (
    target_id text NOT NULL,
    amount numeric NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE dungeon_v2_effect_events (
    sequence integer NOT NULL,
    elapsed_ms numeric NOT NULL,
    effect_id text NOT NULL,
    source_uid text NOT NULL,
    target_uid text NOT NULL,
    amount numeric,
    duration_ms integer
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.dungeon_sim_units(
    side, position, unit_id, hero_uid, hero_class, max_hp, current_hp, atk, def, speed, attack_speed,
    crit_chance, crit_damage, dodge, def_cap, next_attack_ms, alive
  )
  SELECT
    'hero',
    (room_hero->>'position')::integer,
    'hero:' || (room_hero->>'uid'),
    room_hero->>'uid',
    split_part(snapshot_hero->>'hero_id', '-', 1),
    ROUND((room_hero->>'max_hp')::numeric * CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'knight' THEN 1.15 WHEN 'druid' THEN 1.10 ELSE 1 END),
    ROUND((room_hero->>'current_hp')::numeric * CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'knight' THEN 1.15 WHEN 'druid' THEN 1.10 ELSE 1 END),
    (snapshot_hero->'stats'->>'atk')::numeric,
    (snapshot_hero->'stats'->>'def')::numeric,
    (snapshot_hero->'stats'->>'speed')::numeric,
    LEAST(0.25, GREATEST(0, COALESCE((snapshot_hero->'stats'->>'attack_speed_bonus')::numeric, 0)
      + CASE split_part(snapshot_hero->>'hero_id', '-', 1) WHEN 'archer' THEN 0.08 ELSE 0 END)),
    LEAST(CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'assassin' THEN 0.60 WHEN 'archer' THEN 0.55 WHEN 'shepherd' THEN 0.50 ELSE 0.45 END,
      CASE split_part(snapshot_hero->>'hero_id', '-', 1)
        WHEN 'knight' THEN 0.08 WHEN 'shepherd' THEN 0.12 WHEN 'assassin' THEN 0.23
        WHEN 'druid' THEN 0.10 ELSE 0.15 END + combat_stats.crit_chance),
    LEAST(CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'assassin' THEN 2.50 WHEN 'archer' THEN 2.70 WHEN 'shepherd' THEN 2.30
      WHEN 'druid' THEN 2.10 ELSE 2.00 END,
      CASE split_part(snapshot_hero->>'hero_id', '-', 1)
        WHEN 'knight' THEN 1.60 WHEN 'shepherd' THEN 1.85 WHEN 'assassin' THEN 2.00
        WHEN 'druid' THEN 1.70 ELSE 2.15 END + combat_stats.crit_damage),
    LEAST(CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'assassin' THEN 0.30 WHEN 'archer' THEN 0.20 WHEN 'knight' THEN 0.10 ELSE 0.15 END,
      CASE split_part(snapshot_hero->>'hero_id', '-', 1) WHEN 'assassin' THEN 0.05 ELSE 0 END
        + combat_stats.dodge),
    CASE split_part(snapshot_hero->>'hero_id', '-', 1)
      WHEN 'knight' THEN 0.60 WHEN 'druid' THEN 0.50 WHEN 'archer' THEN 0.45 ELSE 0.40 END,
    public.dungeon_combat_roll(v_encounter.seed, 5, 0, room_hero->>'uid', 'initial')
      * public.dungeon_attack_interval_ms(
        (snapshot_hero->'stats'->>'speed')::numeric,
        LEAST(0.25, GREATEST(0, COALESCE((snapshot_hero->'stats'->>'attack_speed_bonus')::numeric, 0)
          + CASE split_part(snapshot_hero->>'hero_id', '-', 1) WHEN 'archer' THEN 0.08 ELSE 0 END))
      ),
    COALESCE((room_hero->>'alive')::boolean, false)
  FROM jsonb_array_elements(v_encounter.room_state->'heroes') AS room_heroes(room_hero)
  JOIN LATERAL (
    SELECT hero AS snapshot_hero
    FROM jsonb_array_elements(v_encounter.roster_snapshot) AS roster(hero)
    WHERE hero->>'uid' = room_hero->>'uid'
    LIMIT 1
  ) AS snapshot ON true
  JOIN LATERAL (
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN stat->>'key' = 'critChance'
        THEN (stat->>'value')::numeric * (1 + LEAST(10, GREATEST(0, (item->>'enchant_level')::integer)) * 0.1)
        ELSE 0 END), 0) * MAX(rarity_set.multiplier), 3) AS crit_chance,
      ROUND(COALESCE(SUM(CASE WHEN stat->>'key' = 'critDamage'
        THEN (stat->>'value')::numeric * (1 + LEAST(10, GREATEST(0, (item->>'enchant_level')::integer)) * 0.1)
        ELSE 0 END), 0) * MAX(rarity_set.multiplier), 3) AS crit_damage,
      ROUND(COALESCE(SUM(CASE WHEN stat->>'key' = 'dodge'
        THEN (stat->>'value')::numeric * (1 + LEAST(10, GREATEST(0, (item->>'enchant_level')::integer)) * 0.1)
        ELSE 0 END), 0) * MAX(rarity_set.multiplier), 3) AS dodge
    FROM jsonb_array_elements(COALESCE(snapshot_hero->'equipment', '[]'::jsonb)) AS equipment(item)
    LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item->'stats') = 'array'
      THEN item->'stats' ELSE '[]'::jsonb END) AS item_stats(stat) ON true
    CROSS JOIN LATERAL (
      SELECT 1 + CASE WHEN jsonb_array_length(COALESCE(snapshot_hero->'equipment', '[]'::jsonb)) = 8
        AND (SELECT count(DISTINCT equipped->>'rarity')
          FROM jsonb_array_elements(snapshot_hero->'equipment') AS all_equipment(equipped)) = 1
        THEN CASE (snapshot_hero->'equipment'->0->>'rarity')
          WHEN 'common' THEN 0.02 WHEN 'uncommon' THEN 0.04 WHEN 'rare' THEN 0.06 WHEN 'epic' THEN 0.08
          WHEN 'legendary' THEN 0.10 WHEN 'mythic' THEN 0.12 WHEN 'cosmic' THEN 0.14
          WHEN 'divine' THEN 0.16 WHEN 'celestial' THEN 0.18 WHEN 'cursed' THEN 0.20
          WHEN 'immortal' THEN 0.22 WHEN 'god' THEN 0.25 ELSE 0 END ELSE 0 END AS multiplier
    ) AS rarity_set
  ) AS combat_stats ON true;

  INSERT INTO pg_temp.dungeon_sim_units(
    side, position, unit_id, max_hp, current_hp, atk, def, speed, attack_speed,
    crit_chance, crit_damage, dodge, def_cap, next_attack_ms, alive
  )
  SELECT
    'enemy', (enemy->>'lane')::integer, enemy->>'unit_id',
    (enemy->>'max_hp')::numeric, (enemy->>'current_hp')::numeric,
    (enemy->>'atk')::numeric, (enemy->>'def')::numeric, (enemy->>'speed')::numeric,
    0, 0.06, 1.50, 0, 0.50, 0, COALESCE((enemy->>'alive')::boolean, false)
  FROM jsonb_array_elements(v_encounter.room_state->'enemies') AS enemies(enemy);

  IF (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = 'hero')
      <> jsonb_array_length(v_encounter.roster_snapshot)
    OR (SELECT count(*) FROM pg_temp.dungeon_sim_units WHERE side = 'enemy') <> 1 THEN
    RAISE EXCEPTION 'dungeon_room_state_invalid';
  END IF;

  WHILE EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side = 'hero' AND alive)
    AND EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side = 'enemy' AND alive)
  LOOP
    SELECT LEAST(
      MIN(next_attack_ms),
      v_next_regen_ms,
      CASE WHEN EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='hero' AND hero_class='knight' AND alive)
        THEN v_next_aegis_ms ELSE 240001 END
    ) INTO v_event_ms FROM pg_temp.dungeon_sim_units WHERE alive;
    IF v_event_ms IS NULL OR v_event_ms > 240000 OR v_sequence >= 1000 THEN
      v_room_status := 'failed'; v_reason := 'timeout'; EXIT;
    END IF;
    v_sequence := v_sequence + 1;

    UPDATE pg_temp.dungeon_sim_units
    SET barrier_amount = CASE WHEN barrier_until_ms <= v_event_ms THEN 0 ELSE barrier_amount END,
        mark_source_id = CASE WHEN mark_until_ms <= v_event_ms THEN NULL ELSE mark_source_id END,
        expose_source_id = CASE WHEN expose_until_ms <= v_event_ms THEN NULL ELSE expose_source_id END;

    IF v_event_ms = v_next_regen_ms THEN
      SELECT unit_id INTO v_druid_uid FROM pg_temp.dungeon_sim_units
      WHERE side='hero' AND hero_class='druid' AND alive ORDER BY unit_id LIMIT 1;
      IF v_druid_uid IS NOT NULL THEN
        INSERT INTO pg_temp.dungeon_v2_effect_events(sequence,elapsed_ms,effect_id,source_uid,target_uid,amount)
        SELECT v_sequence,v_event_ms,'team.druid.wild-growth-heal',v_druid_uid,hero_uid,
          LEAST(ROUND(max_hp*0.012),max_hp-current_hp)
        FROM pg_temp.dungeon_sim_units WHERE side='hero' AND alive AND current_hp<max_hp;
        UPDATE pg_temp.dungeon_sim_units SET current_hp=LEAST(max_hp,current_hp+ROUND(max_hp*0.012))
        WHERE side='hero' AND alive;
      END IF;
      v_druid_uid := NULL;
      v_next_regen_ms := v_next_regen_ms + 3000;
    END IF;

    IF v_event_ms = v_next_aegis_ms THEN
      FOR v_knight IN SELECT * FROM pg_temp.dungeon_sim_units
        WHERE side='hero' AND hero_class='knight' AND alive ORDER BY position,unit_id
      LOOP
        SELECT * INTO v_aegis_target FROM pg_temp.dungeon_sim_units
        WHERE side='hero' AND alive ORDER BY current_hp/NULLIF(max_hp,0),position,unit_id LIMIT 1;
        IF FOUND THEN
          v_aegis_amount := ROUND(v_knight.max_hp*0.06);
          UPDATE pg_temp.dungeon_sim_units
          SET barrier_amount=GREATEST(barrier_amount,v_aegis_amount),barrier_until_ms=v_event_ms+5000
          WHERE unit_id=v_aegis_target.unit_id;
          INSERT INTO pg_temp.dungeon_v2_effect_events(sequence,elapsed_ms,effect_id,source_uid,target_uid,amount,duration_ms)
          VALUES(v_sequence,v_event_ms,'team.warrior.guardian-aegis',v_knight.hero_uid,v_aegis_target.hero_uid,v_aegis_amount,5000);
        END IF;
      END LOOP;
      v_next_aegis_ms := v_next_aegis_ms + 10000;
    END IF;

    TRUNCATE pg_temp.dungeon_pending_damage;
    FOR v_actor IN SELECT * FROM pg_temp.dungeon_sim_units
      WHERE alive AND next_attack_ms = v_event_ms ORDER BY side,position,unit_id
    LOOP
      IF v_actor.side='hero' THEN
        SELECT * INTO v_target FROM pg_temp.dungeon_sim_units
        WHERE side='enemy' AND position=v_actor.position AND alive
        ORDER BY CASE WHEN unit_id LIKE 'shared-boss-%' THEN 1 ELSE 0 END,unit_id LIMIT 1;
        IF NOT FOUND THEN SELECT * INTO v_target FROM pg_temp.dungeon_sim_units
          WHERE side='enemy' AND alive ORDER BY CASE WHEN unit_id LIKE 'shared-boss-%' THEN 1 ELSE 0 END,
          current_hp/NULLIF(max_hp,0),position,unit_id LIMIT 1; END IF;
      ELSE
        SELECT * INTO v_target FROM pg_temp.dungeon_sim_units
        WHERE side='hero' AND position=v_actor.position AND alive LIMIT 1;
        IF NOT FOUND THEN SELECT * INTO v_target FROM pg_temp.dungeon_sim_units
          WHERE side='hero' AND alive ORDER BY current_hp/NULLIF(max_hp,0) DESC,position,unit_id LIMIT 1; END IF;
      END IF;
      IF FOUND AND public.dungeon_combat_roll(v_encounter.seed,5,v_sequence,v_actor.unit_id,'dodge')>=v_target.dodge THEN
        v_mitigation:=LEAST(v_target.def_cap,
          (v_target.def*CASE WHEN v_target.expose_until_ms>v_event_ms AND v_target.expose_source_id IS DISTINCT FROM v_actor.unit_id THEN 0.94 ELSE 1 END)
          /NULLIF((v_target.def*CASE WHEN v_target.expose_until_ms>v_event_ms AND v_target.expose_source_id IS DISTINCT FROM v_actor.unit_id THEN 0.94 ELSE 1 END)+2*v_actor.atk,0));
        v_critical:=CASE WHEN public.dungeon_combat_roll(v_encounter.seed,5,v_sequence,v_actor.unit_id,'critical')<v_actor.crit_chance
          THEN v_actor.crit_damage ELSE 1 END;
        v_mark_multiplier:=CASE WHEN v_target.mark_until_ms>v_event_ms AND v_target.mark_source_id IS DISTINCT FROM v_actor.unit_id THEN 1.04 ELSE 1 END;
        v_damage:=GREATEST(1,ROUND(v_actor.atk*(1-v_mitigation)*v_critical*v_mark_multiplier
          *(0.9+public.dungeon_combat_roll(v_encounter.seed,5,v_sequence,v_actor.unit_id,'variance')*0.2)
          *CASE WHEN v_actor.side='hero' AND v_target.unit_id LIKE 'shared-boss-grave-necromancer%'
            AND EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='enemy' AND alive AND unit_id LIKE 'necromancer-summon-%')
            THEN 0.75 ELSE 1 END));
        INSERT INTO pg_temp.dungeon_pending_damage(target_id,amount) VALUES(v_target.unit_id,v_damage);
        UPDATE pg_temp.dungeon_sim_units SET landed_hits=landed_hits+1 WHERE unit_id=v_actor.unit_id;

        IF v_actor.side='hero' AND v_actor.hero_class='shepherd' AND (v_actor.landed_hits+1)%5=0 THEN
          v_echo_damage:=ROUND(v_damage*0.5);
          INSERT INTO pg_temp.dungeon_pending_damage(target_id,amount) VALUES(v_target.unit_id,v_echo_damage);
          UPDATE pg_temp.dungeon_sim_units SET mark_source_id=v_actor.unit_id,mark_until_ms=v_event_ms+4000 WHERE unit_id=v_target.unit_id;
          INSERT INTO pg_temp.dungeon_v2_effect_events(sequence,elapsed_ms,effect_id,source_uid,target_uid,amount,duration_ms)
          VALUES(v_sequence,v_event_ms,'core.mage.arcane-echo',v_actor.hero_uid,v_target.unit_id,v_echo_damage,NULL),
            (v_sequence,v_event_ms,'team.mage.arcane-mark',v_actor.hero_uid,v_target.unit_id,NULL,4000);
        END IF;
        IF v_actor.side='hero' AND v_actor.hero_class='assassin' AND v_critical>1 AND v_actor.expose_ready_ms<=v_event_ms THEN
          UPDATE pg_temp.dungeon_sim_units SET expose_source_id=v_actor.unit_id,expose_until_ms=v_event_ms+4000 WHERE unit_id=v_target.unit_id;
          UPDATE pg_temp.dungeon_sim_units SET expose_ready_ms=v_event_ms+6000 WHERE unit_id=v_actor.unit_id;
          INSERT INTO pg_temp.dungeon_v2_effect_events(sequence,elapsed_ms,effect_id,source_uid,target_uid,duration_ms)
          VALUES(v_sequence,v_event_ms,'team.assassin.expose',v_actor.hero_uid,v_target.unit_id,4000);
        END IF;
        IF v_actor.side='hero' AND v_actor.hero_class='archer' AND (v_actor.landed_hits+1)%5=0 THEN
          UPDATE pg_temp.dungeon_sim_units SET suppression_until_ms=v_event_ms+4000 WHERE unit_id=v_target.unit_id;
          INSERT INTO pg_temp.dungeon_v2_effect_events(sequence,elapsed_ms,effect_id,source_uid,target_uid,duration_ms)
          VALUES(v_sequence,v_event_ms,'team.crossbowman.suppressing-fire',v_actor.hero_uid,v_target.unit_id,4000);
        END IF;
      END IF;
      UPDATE pg_temp.dungeon_sim_units SET attacks=attacks+1,
        next_attack_ms=next_attack_ms+public.dungeon_attack_interval_ms(speed,attack_speed)
          *CASE WHEN suppression_until_ms>v_event_ms THEN 1/0.92 ELSE 1 END
      WHERE unit_id=v_actor.unit_id;
    END LOOP;

    UPDATE pg_temp.dungeon_sim_units AS unit SET
      current_hp=GREATEST(0,unit.current_hp-GREATEST(0,pending.amount-unit.barrier_amount)),
      alive=unit.current_hp-GREATEST(0,pending.amount-unit.barrier_amount)>0,
      barrier_amount=GREATEST(0,unit.barrier_amount-pending.amount)
    FROM (SELECT target_id,SUM(amount) amount FROM pg_temp.dungeon_pending_damage GROUP BY target_id) pending
    WHERE unit.unit_id=pending.target_id;

    IF v_encounter.room_state->'boss'->>'boss_id'='grave-necromancer' THEN
      IF EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id LIKE 'shared-boss-grave-necromancer%' AND current_hp/max_hp<=0.70)
        AND NOT EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id='necromancer-summon-1-0') THEN
        INSERT INTO pg_temp.dungeon_sim_units(side,position,unit_id,max_hp,current_hp,atk,def,speed,attack_speed,crit_chance,crit_damage,dodge,def_cap,next_attack_ms,alive)
        SELECT 'enemy',slot,'necromancer-summon-1-'||slot,ROUND(b.max_hp*.30),ROUND(b.max_hp*.30),ROUND(b.atk*.30),b.def,95,0,0.03,1.5,0,.5,v_event_ms+600,true
        FROM pg_temp.dungeon_sim_units b CROSS JOIN generate_series(0,1) slot WHERE b.unit_id LIKE 'shared-boss-grave-necromancer%';
      END IF;
      IF EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id LIKE 'shared-boss-grave-necromancer%' AND current_hp/max_hp<=0.35)
        AND NOT EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id='necromancer-summon-2-0') THEN
        INSERT INTO pg_temp.dungeon_sim_units(side,position,unit_id,max_hp,current_hp,atk,def,speed,attack_speed,crit_chance,crit_damage,dodge,def_cap,next_attack_ms,alive)
        SELECT 'enemy',slot,'necromancer-summon-2-'||slot,ROUND(b.max_hp*.30),ROUND(b.max_hp*.30),ROUND(b.atk*.30),b.def,95,0,0.03,1.5,0,.5,v_event_ms+600,true
        FROM pg_temp.dungeon_sim_units b CROSS JOIN generate_series(0,1) slot WHERE b.unit_id LIKE 'shared-boss-grave-necromancer%';
      END IF;
    END IF;
  END LOOP;

  IF v_room_status<>'failed' THEN
    IF NOT EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='hero' AND alive) THEN v_room_status:='failed';v_reason:='party_defeated';
    ELSIF EXISTS(SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side='enemy' AND alive) THEN v_room_status:='failed';v_reason:='timeout';
    ELSE v_room_status:='cleared';v_reason:='boss_defeated'; END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('position',position,'uid',hero_uid,
    'hero_id',(SELECT hero->>'hero_id' FROM jsonb_array_elements(v_encounter.roster_snapshot) roster(hero) WHERE hero->>'uid'=hero_uid LIMIT 1),
    'max_hp',max_hp,'current_hp',ROUND(current_hp),'alive',alive,'attacks',attacks,'landed_hits',landed_hits)
    ORDER BY position) INTO v_heroes FROM pg_temp.dungeon_sim_units WHERE side='hero';
  SELECT jsonb_agg(jsonb_build_object('unit_id',unit_id,'lane',position,'max_hp',max_hp,'current_hp',ROUND(current_hp),
    'atk',atk,'def',def,'speed',speed,'alive',alive,'attacks',attacks)
    ORDER BY CASE WHEN unit_id LIKE 'shared-boss-%' THEN 0 ELSE 1 END,position,unit_id)
    INTO v_enemies FROM pg_temp.dungeon_sim_units WHERE side='enemy';
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('sequence',sequence,'elapsed_ms',ROUND(elapsed_ms),
    'effect_id',effect_id,'source_uid',source_uid,'target_uid',target_uid,'amount',amount,'duration_ms',duration_ms))
    ORDER BY sequence,effect_id,source_uid,target_uid),'[]'::jsonb)
    INTO v_effect_events FROM pg_temp.dungeon_v2_effect_events;

  v_room_state:=v_encounter.room_state||jsonb_build_object('status',v_room_status,'sequence',v_sequence,
    'elapsed_ms',LEAST(240000,ROUND(v_event_ms)),'heroes',v_heroes,'enemies',v_enemies,
    'combat_effects_version','combat-effects-v2-team-contributions-candidate-2026.09.06-v1',
    'effect_events',v_effect_events,'resolution',jsonb_build_object('reason',v_reason,'resolved_at',now()));
  UPDATE public.dungeon_encounters SET room_state=v_room_state,revision=revision+1 WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  v_result:=jsonb_build_object('encounter_id',v_encounter.id,'room',v_encounter.room,'revision',v_encounter.revision,'room_state',v_encounter.room_state);
  INSERT INTO public.dungeon_events(idempotency_key,player_id,encounter_id,action,request,result)
  VALUES(p_idempotency_key,p_player_id,v_encounter.id,'room_action',v_request,v_result);
  RETURN v_result;
END;
$$;

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
  v_balance_version text;
BEGIN
  SELECT balance_version INTO v_balance_version FROM public.dungeon_encounters
  WHERE id=p_encounter_id AND player_id=p_player_id;
  IF v_balance_version='2026.09.06-shared-boss-effects-v2-candidate' THEN
    v_result:=public.dungeon_shared_boss_v2_basic_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  ELSE
    v_result:=public.dungeon_shared_boss_basic_action(p_player_id,p_encounter_id,p_expected_revision,p_action_kind,p_idempotency_key);
  END IF;
  IF v_result->'room_state' ? 'heavy_target_uid' THEN RETURN v_result; END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters WHERE id=p_encounter_id AND player_id=p_player_id FOR UPDATE;
  IF NOT FOUND OR v_encounter.room_state->>'kind'<>'shared_boss' THEN RAISE EXCEPTION 'dungeon_room_state_invalid'; END IF;
  v_boss:=v_encounter.room_state->'enemies'->0;
  SELECT hero->>'uid',COALESCE((snapshot->'stats'->>'power')::numeric,0) INTO v_target_uid,v_target_power
  FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero
  JOIN LATERAL (SELECT value snapshot FROM jsonb_array_elements(v_encounter.roster_snapshot)
    WHERE value->>'uid'=hero->>'uid' LIMIT 1) matched ON true
  WHERE COALESCE((hero->>'alive')::boolean,false)
  ORDER BY COALESCE((snapshot->'stats'->>'power')::numeric,0) DESC,hero->>'uid' LIMIT 1;
  IF v_target_uid IS NULL THEN SELECT hero->>'uid' INTO v_target_uid FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero
    ORDER BY (hero->>'position')::integer LIMIT 1; END IF;
  v_heavy_casts:=GREATEST(1,FLOOR(COALESCE((v_encounter.room_state->>'elapsed_ms')::numeric,0)/10000)::integer);
  v_identity_casts:=GREATEST(1,FLOOR(COALESCE((v_encounter.room_state->>'elapsed_ms')::numeric,0)/
    CASE v_encounter.room_state->'boss'->>'boss_id' WHEN 'iron-warden' THEN 14000 WHEN 'ash-warlock' THEN 12000
      WHEN 'thorn-shaman' THEN 16000 ELSE 240000 END)::integer);
  v_identity_ability:=CASE v_encounter.room_state->'boss'->>'boss_id' WHEN 'iron-warden' THEN 'Bulwark'
    WHEN 'ash-warlock' THEN 'Ashen Ruin' WHEN 'thorn-shaman' THEN 'Thorn Renewal'
    WHEN 'rift-behemoth' THEN 'Rift Fury' ELSE 'Raise Dead' END;
  v_heavy_damage:=GREATEST(1,ROUND(COALESCE((v_boss->>'atk')::numeric,1)*1.6*v_heavy_casts));
  SELECT jsonb_agg(CASE WHEN hero->>'uid'=v_target_uid AND COALESCE((hero->>'alive')::boolean,false)
    THEN hero||jsonb_build_object('current_hp',GREATEST(1,ROUND((hero->>'current_hp')::numeric-v_heavy_damage)),
      'heavy_damage_taken',v_heavy_damage) ELSE hero END ORDER BY (hero->>'position')::integer) INTO v_heroes
  FROM jsonb_array_elements(v_encounter.room_state->'heroes') hero;
  UPDATE public.dungeon_encounters SET room_state=room_state||jsonb_build_object('heroes',v_heroes,'heavy_target_uid',v_target_uid,
    'heavy_casts',v_heavy_casts,'heavy_warning_ms',3000,'heavy_recovery_ms',7000,'identity_ability',v_identity_ability,
    'identity_casts',v_identity_casts,'telegraph_version','2026.08.13-dungeon-boss-v1')
  WHERE id=v_encounter.id RETURNING * INTO v_encounter;
  v_result:=v_result||jsonb_build_object('room_state',v_encounter.room_state);
  UPDATE public.dungeon_events SET result=v_result WHERE idempotency_key=p_idempotency_key AND player_id=p_player_id AND action='room_action';
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dungeon_combat_effects_version_gate() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_shared_boss_version_gate() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.dungeon_shared_boss_v2_basic_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid) TO service_role;

COMMIT;
