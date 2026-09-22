CREATE OR REPLACE FUNCTION public.boss_hunt_gold_reward(p_location integer, p_roster_snapshot jsonb)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_hero jsonb;
  v_item jsonb;
  v_stat jsonb;
  v_equipment jsonb;
  v_item_count integer;
  v_set_rarity text;
  v_min_enchant integer;
  v_set_bonus numeric;
  v_resonance numeric;
  v_multiplier numeric;
  v_bonus numeric := 0;
  v_team_size integer;
  v_gold_per_lane bigint;
BEGIN
  IF jsonb_typeof(p_roster_snapshot) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_roster_snapshot) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'boss_reward_snapshot_invalid';
  END IF;
  v_team_size := jsonb_array_length(p_roster_snapshot);

  FOR v_hero IN SELECT value FROM jsonb_array_elements(p_roster_snapshot) LOOP
    v_equipment := COALESCE(v_hero->'equipment', '[]'::jsonb);
    IF jsonb_typeof(v_equipment) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'boss_reward_snapshot_invalid';
    END IF;
    v_item_count := jsonb_array_length(v_equipment);
    v_set_rarity := NULL;
    v_min_enchant := 0;
    IF v_item_count = 8 THEN
      SELECT CASE WHEN count(DISTINCT item->>'rarity') = 1 THEN min(item->>'rarity') ELSE NULL END,
        LEAST(10, GREATEST(0, min(COALESCE((item->>'enchant_level')::integer, 0))))
      INTO v_set_rarity, v_min_enchant
      FROM jsonb_array_elements(v_equipment) entries(item);
    END IF;
    v_set_bonus := CASE v_set_rarity
      WHEN 'common' THEN 0.02 WHEN 'uncommon' THEN 0.04 WHEN 'rare' THEN 0.06
      WHEN 'epic' THEN 0.08 WHEN 'legendary' THEN 0.10 WHEN 'mythic' THEN 0.12
      WHEN 'relic' THEN 0.12 WHEN 'cosmic' THEN 0.14 WHEN 'divine' THEN 0.16
      WHEN 'celestial' THEN 0.18 WHEN 'cursed' THEN 0.20 WHEN 'immortal' THEN 0.22
      WHEN 'god' THEN 0.25 ELSE 0 END;
    v_resonance := CASE WHEN v_item_count = 8 THEN
      (ARRAY[0,1,2,4,7,11,16,22,30,39,50])[v_min_enchant + 1]::numeric / 100
      ELSE 0 END;

    FOR v_item IN SELECT value FROM jsonb_array_elements(v_equipment) LOOP
      v_multiplier := 1 + LEAST(10, GREATEST(0, COALESCE((v_item->>'enchant_level')::integer, 0))) * 0.1
        + v_set_bonus + v_resonance;
      FOR v_stat IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_item->'stats') = 'array' THEN v_item->'stats' ELSE '[]'::jsonb END
      ) LOOP
        IF v_stat->>'key' = 'goldBonus' AND jsonb_typeof(v_stat->'value') = 'number' THEN
          v_bonus := v_bonus + round(LEAST(1000000000::numeric, GREATEST(-1000000000::numeric,
            (v_stat->>'value')::numeric)) * v_multiplier, 3);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  v_gold_per_lane := GREATEST(0, round((5 + LEAST(10, GREATEST(1, p_location))) * 3 * (1 + v_bonus)));
  RETURN v_gold_per_lane * v_team_size;
END;
$$;

CREATE OR REPLACE FUNCTION public.boss_claim(
  p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.boss_claim_events%ROWTYPE; v_boss public.boss_encounters%ROWTYPE;
  v_encounter public.dungeon_encounters%ROWTYPE; v_save public.player_saves%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id', p_encounter_id, 'expected_revision', p_expected_revision);
  v_state jsonb; v_chests jsonb; v_chest jsonb; v_result jsonb; v_revision bigint; v_gold bigint;
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  v_day text := to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'); v_last_day text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('encounter:' || p_player_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.boss_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_encounter FROM public.dungeon_encounters
  WHERE id = p_encounter_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_encounter_not_found'; END IF;
  SELECT * INTO v_boss FROM public.boss_encounters
  WHERE player_id = p_player_id AND dungeon_encounter_id = v_encounter.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'boss_encounter_not_found'; END IF;
  IF v_boss.status <> 'active' OR v_encounter.status <> 'active' THEN RAISE EXCEPTION 'boss_encounter_not_active'; END IF;
  IF v_encounter.revision <> p_expected_revision THEN RAISE EXCEPTION 'dungeon_revision_conflict'; END IF;
  IF v_encounter.room <> 4 OR v_encounter.room_state->>'kind' <> 'shared_boss'
    OR v_encounter.room_state->>'status' <> 'reward_locked' THEN RAISE EXCEPTION 'boss_reward_not_ready'; END IF;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_state := v_save.state; v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' OR jsonb_array_length(v_chests) >= 500 THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;
  v_last_day := to_char(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000) AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms), true);
  END IF;
  IF COALESCE((v_state->>'chestsOpenedToday')::integer, 0) >= 1000 THEN RAISE EXCEPTION 'daily_chest_limit_reached'; END IF;
  v_chest := jsonb_build_object('id', 'boss-' || v_boss.id::text, 'stage', v_boss.location_id, 'boss', true);
  v_gold := public.boss_hunt_gold_reward(v_boss.location_id, v_encounter.roster_snapshot);
  v_state := jsonb_set(v_state, '{chests}', v_chests || jsonb_build_array(v_chest), true);
  v_state := jsonb_set(v_state, '{chestsOpenedToday}', to_jsonb(COALESCE((v_state->>'chestsOpenedToday')::integer, 0) + 1), true);
  v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{session,goldToday}', to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{totalBossKills}', to_jsonb(COALESCE((v_state->>'totalBossKills')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{session,bossKills}', to_jsonb(COALESCE((v_state#>>'{session,bossKills}')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.advance_boss_quests(v_state->'dailyQuests', false), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.advance_boss_quests(v_state->'milestoneQuests', true), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'gold-earned-', v_gold), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET boss_kills = COALESCE(boss_kills, 0) + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.boss_encounters SET status = 'claimed', completed_at = now() WHERE id = v_boss.id;
  UPDATE public.dungeon_encounters SET status = 'completed', revision = revision + 1, completed_at = now()
  WHERE id = v_encounter.id RETURNING * INTO v_encounter;
  v_result := jsonb_build_object('encounter_id', v_encounter.id, 'boss_encounter_id', v_boss.id,
    'status', 'completed', 'revision', v_encounter.revision, 'boss_chest', v_chest, 'gold', v_gold,
    'gold_source_key', 'boss-gold:' || v_boss.id::text,
    'state', v_state, 'save_revision', v_revision, 'reward_settled', true);
  INSERT INTO public.boss_claim_events(idempotency_key, player_id, boss_encounter_id, request, result)
  VALUES (p_idempotency_key, p_player_id, v_boss.id, v_request, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.boss_hunt_gold_reward(integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.boss_claim(uuid, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.boss_claim(uuid, uuid, bigint, uuid) TO service_role;
