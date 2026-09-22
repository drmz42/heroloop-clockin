DO $$
DECLARE
  v_definition text:=pg_get_functiondef('public.dungeon_shared_boss_basic_action(uuid,uuid,bigint,text,uuid)'::regprocedure);
  v_after_damage text;
BEGIN
  IF position('UPDATE pg_temp.dungeon_sim_units AS unit' in v_definition)=0
    OR position('WHERE side = ''enemy'' AND position = v_actor.position AND alive LIMIT 1' in v_definition)=0 THEN
    RAISE EXCEPTION 'dungeon_shared_boss_resolver_definition_mismatch';
  END IF;

  v_definition:=replace(v_definition,
    'WHERE side = ''enemy'' AND position = v_actor.position AND alive LIMIT 1',
    'WHERE side = ''enemy'' AND position = v_actor.position AND alive'||chr(10)||
    '        ORDER BY CASE WHEN unit_id LIKE ''shared-boss-%'' THEN 1 ELSE 0 END, unit_id LIMIT 1');

  v_definition:=replace(v_definition,
    '* (0.9 + public.dungeon_combat_roll(v_encounter.seed, 5, v_sequence, v_actor.unit_id, ''variance'') * 0.2)))',
    '* (0.9 + public.dungeon_combat_roll(v_encounter.seed, 5, v_sequence, v_actor.unit_id, ''variance'') * 0.2)'||chr(10)||
    '            * CASE WHEN v_actor.side = ''hero'' AND v_target.unit_id LIKE ''shared-boss-grave-necromancer%'''||chr(10)||
    '              AND EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE side=''enemy'' AND alive AND unit_id LIKE ''necromancer-summon-%'')'||chr(10)||
    '              THEN 0.75 ELSE 1 END))');

  v_after_damage:='    IF v_encounter.room_state->''boss''->>''boss_id'' = ''grave-necromancer'' THEN'||chr(10)||
    '      IF EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id LIKE ''shared-boss-grave-necromancer%'' AND current_hp/max_hp <= 0.70)'||chr(10)||
    '        AND NOT EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id=''necromancer-summon-1-0'') THEN'||chr(10)||
    '        INSERT INTO pg_temp.dungeon_sim_units(side,position,unit_id,max_hp,current_hp,atk,def,speed,attack_speed,crit_chance,crit_damage,dodge,def_cap,next_attack_ms,alive)'||chr(10)||
    '        SELECT ''enemy'',slot,''necromancer-summon-1-''||slot,ROUND(b.max_hp*.30),ROUND(b.max_hp*.30),ROUND(b.atk*.30),b.def,95,0,0.03,1.5,0,.5,v_event_ms+600,true'||chr(10)||
    '        FROM pg_temp.dungeon_sim_units b CROSS JOIN generate_series(0,1) slot WHERE b.unit_id LIKE ''shared-boss-grave-necromancer%'';'||chr(10)||
    '      END IF;'||chr(10)||
    '      IF EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id LIKE ''shared-boss-grave-necromancer%'' AND current_hp/max_hp <= 0.35)'||chr(10)||
    '        AND NOT EXISTS (SELECT 1 FROM pg_temp.dungeon_sim_units WHERE unit_id=''necromancer-summon-2-0'') THEN'||chr(10)||
    '        INSERT INTO pg_temp.dungeon_sim_units(side,position,unit_id,max_hp,current_hp,atk,def,speed,attack_speed,crit_chance,crit_damage,dodge,def_cap,next_attack_ms,alive)'||chr(10)||
    '        SELECT ''enemy'',slot,''necromancer-summon-2-''||slot,ROUND(b.max_hp*.30),ROUND(b.max_hp*.30),ROUND(b.atk*.30),b.def,95,0,0.03,1.5,0,.5,v_event_ms+600,true'||chr(10)||
    '        FROM pg_temp.dungeon_sim_units b CROSS JOIN generate_series(0,1) slot WHERE b.unit_id LIKE ''shared-boss-grave-necromancer%'';'||chr(10)||
    '      END IF;'||chr(10)||
    '    END IF;'||chr(10);

  v_definition:=replace(v_definition,
    '    WHERE unit.unit_id = pending.target_id;'||chr(10)||'  END LOOP;',
    '    WHERE unit.unit_id = pending.target_id;'||chr(10)||v_after_damage||'  END LOOP;');
  v_definition:=replace(v_definition,'  ) ORDER BY position) INTO v_enemies',
    '  ) ORDER BY CASE WHEN unit_id LIKE ''shared-boss-%'' THEN 0 ELSE 1 END, position, unit_id) INTO v_enemies');
  EXECUTE v_definition;
END $$;

REVOKE ALL ON FUNCTION public.dungeon_shared_boss_basic_action(uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
