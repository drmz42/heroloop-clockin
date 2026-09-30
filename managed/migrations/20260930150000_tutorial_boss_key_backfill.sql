-- One-time repair for players already stuck before 20260930130000_tutorial_boss_key_regrant:
-- their Tutorial Boss Hunt was lost earlier, so the new trigger never fired for them.
-- For every player with a lost Boss Hunt and no active encounter, try the same guarded
-- regrant on the latest lost hunt. tutorial_boss_key_regrant() itself requires Tutorial
-- quest 9-10 unfinished, no Boss kill since the key grant and zero Boss Keys, and its
-- ledger key is derived from that hunt, so re-running this block grants nothing twice.
DO $$
DECLARE v_row record; v_granted integer := 0;
BEGIN
  FOR v_row IN
    SELECT DISTINCT ON (boss.player_id) boss.player_id, boss.dungeon_encounter_id
    FROM public.boss_encounters boss
    WHERE boss.status = 'lost' AND boss.dungeon_encounter_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.dungeon_encounters active WHERE active.player_id = boss.player_id AND active.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM public.boss_encounters active WHERE active.player_id = boss.player_id AND active.status = 'active')
    ORDER BY boss.player_id, boss.completed_at DESC NULLS LAST
  LOOP
    IF public.tutorial_boss_key_regrant(v_row.player_id, v_row.dungeon_encounter_id) THEN v_granted := v_granted + 1; END IF;
  END LOOP;
  RAISE NOTICE 'tutorial boss key backfill: % player(s)', v_granted;
END $$;
