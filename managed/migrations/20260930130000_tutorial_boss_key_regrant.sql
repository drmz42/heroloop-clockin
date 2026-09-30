-- Tutorial dead end (HL-TASK-20260930121647-CB130A): quest 8 grants one Boss Key and
-- quest 10 needs one Boss kill. Losing or abandoning that Boss Hunt spent the only
-- key and left the quest unfinishable. While the Tutorial is unfinished and no Boss
-- has been killed since the key grant, a lost Boss Hunt now returns one Boss Key.
-- Nothing else changes: a lost hunt still pays no reward, a player holding other
-- keys gets nothing back, and after the first Boss kill the rule no longer applies.

CREATE OR REPLACE FUNCTION public.tutorial_boss_key_regrant(p_player_id uuid, p_dungeon_encounter_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_save public.player_saves%ROWTYPE; v_tutorial jsonb; v_resource jsonb; v_keys bigint;
  v_key uuid := md5('tutorial-boss-key-regrant:' || p_dungeon_encounter_id::text)::uuid;
BEGIN
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_tutorial := CASE WHEN jsonb_typeof(v_save.state->'tutorial') = 'object' THEN v_save.state->'tutorial' ELSE '{}'::jsonb END;
  IF COALESCE((v_tutorial->>'questCompleted')::boolean, false)
    OR COALESCE((v_tutorial->>'questOrdinal')::integer, 1) NOT IN (9, 10)
    OR COALESCE((v_save.state->>'totalBossKills')::bigint, 0) - COALESCE((v_tutorial->>'bossKillsAtKeyGrant')::bigint, 0) >= 1
    OR COALESCE((SELECT quantity_bigint FROM public.player_resource_balances
      WHERE player_id = p_player_id AND resource_id = 'boss_key'), 0) > 0 THEN
    RETURN false;
  END IF;
  v_resource := public.apply_resource_entries(p_player_id, v_key, 'tutorial_boss_key_regrant',
    encode(extensions.digest(p_dungeon_encounter_id::text, 'sha256'), 'hex'),
    '[{"resource_id":"boss_key","delta":"1","source_key":"tutorial_boss_key"}]'::jsonb, v_save.revision + 1);
  IF COALESCE((v_resource->>'replayed')::boolean, false) THEN RETURN false; END IF;
  v_keys := COALESCE((v_resource#>>'{balances,boss_key}')::bigint, 0);
  UPDATE public.players SET boss_keys = v_keys, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = jsonb_set(state, '{bossKeys}', to_jsonb(v_keys), true),
    revision = revision + 1, updated_at = now() WHERE player_id = p_player_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_boss_hunt_terminal_state()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lost integer;
BEGIN
  IF OLD.status = 'active' AND NEW.status IN ('failed', 'abandoned') THEN
    UPDATE public.boss_encounters SET status = 'lost', completed_at = COALESCE(NEW.completed_at, now())
    WHERE dungeon_encounter_id = NEW.id AND status = 'active';
    GET DIAGNOSTICS v_lost = ROW_COUNT;
    IF v_lost > 0 THEN PERFORM public.tutorial_boss_key_regrant(NEW.player_id, NEW.id); END IF;
  ELSIF OLD.status = 'active' AND NEW.status = 'completed' AND OLD.room_state->>'status' = 'reward_locked'
    AND EXISTS (SELECT 1 FROM public.boss_encounters WHERE dungeon_encounter_id = NEW.id AND status = 'active') THEN
    RAISE EXCEPTION 'boss_claim_required';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tutorial_boss_key_regrant(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_boss_hunt_terminal_state() FROM PUBLIC, anon, authenticated;
