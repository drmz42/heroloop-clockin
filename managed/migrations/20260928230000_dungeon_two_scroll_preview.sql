-- Align future Dungeon reward previews with the Founder-approved two-scroll rule.
-- Settlement stays disabled until the reward claim and weekly eligibility are implemented.
DO $$
DECLARE
  v_signature regprocedure := 'public.dungeon_room_complete(uuid,uuid,bigint,uuid)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_old text := '''summon_scrolls'',1,''dungeon_chests'',1,''settled'',false,''reward_table_version'',''dungeon-reward-v1''';
  v_new text := '''summon_scrolls'',2,''dungeon_chests'',1,''settled'',false,''reward_table_version'',''dungeon-reward-v2''';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'dungeon_two_scroll_preview_definition_mismatch';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$$;
