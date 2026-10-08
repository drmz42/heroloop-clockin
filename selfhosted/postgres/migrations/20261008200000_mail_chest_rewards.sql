-- Founder 2026-10-08: every reward goes to the Mailbox first, so a full chest queue or bag never blocks a
-- reward. Claiming from the Mailbox checks room: items need a free bag slot, chests need room in the
-- 500-chest queue; whatever does not fit stays in the Mailbox. This migration adds chest rewards to the
-- Mailbox and routes the Boss Hunt chest there; other chest sources follow the same rule as they move.
BEGIN;

CREATE TABLE IF NOT EXISTS public.player_mail_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('chest')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source text NOT NULL CHECK (source IN ('boss_reward')),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  outcome text CHECK (outcome IN ('claimed'))
);
CREATE INDEX IF NOT EXISTS player_mail_rewards_open_player
  ON public.player_mail_rewards(player_id, created_at, id) WHERE claimed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_mail_rewards_source_once
  ON public.player_mail_rewards(player_id, source, source_ref) WHERE source_ref IS NOT NULL;
ALTER TABLE public.player_mail_rewards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_mail_rewards FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.mail_deliver_reward(p_player_id uuid, p_kind text, p_payload jsonb, p_source text, p_source_ref text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.player_mail_rewards(player_id, kind, payload, source, source_ref)
    VALUES (p_player_id, p_kind, p_payload, p_source, left(p_source_ref, 80))
    RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;
REVOKE ALL ON FUNCTION public.mail_deliver_reward(uuid,text,jsonb,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_api.mail_list(p_player_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL)
      + (SELECT count(*) FROM public.player_mail_rewards WHERE player_id = p_player_id AND claimed_at IS NULL),
    'rewards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', reward.id, 'kind', reward.kind, 'source', reward.source, 'created_at', reward.created_at, 'payload', reward.payload)
        ORDER BY reward.created_at, reward.id)
      FROM (SELECT * FROM public.player_mail_rewards WHERE player_id = p_player_id AND claimed_at IS NULL ORDER BY created_at, id LIMIT 200) reward
    ), '[]'::jsonb),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', mail.id, 'source', mail.source, 'created_at', mail.created_at, 'item', public.mail_item_json(item)
      ) ORDER BY mail.created_at, mail.id)
      FROM (
        SELECT * FROM public.player_mail_items
        WHERE player_id = p_player_id AND claimed_at IS NULL
        ORDER BY created_at, id LIMIT 200
      ) mail
      JOIN public.player_items item ON item.id = mail.item_id
    ), '[]'::jsonb)
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.mail_claim(p_player_id uuid, p_idempotency_key uuid, p_mail_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_request jsonb := jsonb_build_object('mail_id', p_mail_id);
  v_existing public.player_mail_claim_events%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_revision bigint;
  v_free integer;
  v_mail public.player_mail_items%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_claimed integer := 0;
  v_changed boolean := false;
  v_remaining integer;
  v_result jsonb;
  v_chests jsonb;
  v_reward public.player_mail_rewards%ROWTYPE;
  v_items_full boolean := false;
  v_chests_full boolean := false;
  v_is_reward boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.player_mail_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    -- The receipt keeps counts only; a replay returns the current canonical bag.
    RETURN (v_existing.result - 'inventory' - 'chests') || COALESCE((
      SELECT jsonb_build_object('inventory', COALESCE(state->'inventory', '[]'::jsonb), 'chests', COALESCE(state->'chests', '[]'::jsonb))
      FROM public.player_saves WHERE player_id = p_player_id
    ), '{}'::jsonb);
  END IF;

  SELECT state, revision INTO v_state, v_revision FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_free := public.inventory_bag_capacity(v_state) - public.server_market_bag_count(v_state);
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN v_chests := '[]'::jsonb; END IF;

  IF p_mail_id IS NOT NULL THEN
    v_is_reward := EXISTS (SELECT 1 FROM public.player_mail_rewards WHERE id = p_mail_id AND player_id = p_player_id AND claimed_at IS NULL);
    IF NOT v_is_reward AND NOT EXISTS (
      SELECT 1 FROM public.player_mail_items WHERE id = p_mail_id AND player_id = p_player_id AND claimed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'mail_not_found';
    END IF;
  END IF;

  FOR v_mail IN
    SELECT * FROM public.player_mail_items
    WHERE player_id = p_player_id AND claimed_at IS NULL AND NOT v_is_reward AND (p_mail_id IS NULL OR id = p_mail_id)
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    SELECT * INTO v_item FROM public.player_items
      WHERE id = v_mail.item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'unavailable' WHERE id = v_mail.id;
      CONTINUE;
    END IF;
    -- A save that already carries this uid must not get a second copy.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory) entry WHERE entry->>'uid' = v_item.id::text) THEN
      UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'already_in_bag' WHERE id = v_mail.id;
      CONTINUE;
    END IF;
    IF v_free <= 0 THEN
      IF p_mail_id IS NOT NULL THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;
      v_items_full := true;
      EXIT;
    END IF;
    v_inventory := v_inventory || jsonb_build_array(public.mail_item_json(v_item));
    UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'claimed' WHERE id = v_mail.id;
    v_free := v_free - 1;
    v_claimed := v_claimed + 1;
    v_changed := true;
  END LOOP;

  -- Chest rewards move into the 500-chest queue while it has room; the rest wait here.
  FOR v_reward IN
    SELECT * FROM public.player_mail_rewards
    WHERE player_id = p_player_id AND claimed_at IS NULL AND kind = 'chest' AND (p_mail_id IS NULL OR id = p_mail_id)
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    IF jsonb_array_length(v_chests) >= 500 THEN v_chests_full := true; EXIT; END IF;
    v_chests := v_chests || jsonb_build_array(v_reward.payload);
    UPDATE public.player_mail_rewards SET claimed_at = now(), outcome = 'claimed' WHERE id = v_reward.id;
    v_claimed := v_claimed + 1;
    v_changed := true;
  END LOOP;
  -- Claim all with a full bag and nothing else to take keeps its old answer.
  IF p_mail_id IS NULL AND v_claimed = 0 AND v_items_full AND NOT v_chests_full THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;

  IF v_changed THEN
    v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
    v_state := jsonb_set(v_state, '{chests}', v_chests, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  END IF;
  SELECT (SELECT count(*) FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL)
    + (SELECT count(*) FROM public.player_mail_rewards WHERE player_id = p_player_id AND claimed_at IS NULL) INTO v_remaining;
  v_result := jsonb_build_object('claimed', v_claimed, 'remaining', v_remaining, 'revision', v_revision, 'items_full', v_items_full, 'chests_full', v_chests_full);
  INSERT INTO public.player_mail_claim_events(idempotency_key, player_id, request, result)
    VALUES (p_idempotency_key, p_player_id, v_request, v_result);
  RETURN v_result || jsonb_build_object('inventory', v_inventory, 'chests', v_chests);
END
$function$;
REVOKE ALL ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) TO heroloop_api;

CREATE OR REPLACE FUNCTION public.boss_claim(p_player_id uuid, p_encounter_id uuid, p_expected_revision bigint, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.boss_claim_events%ROWTYPE; v_boss public.boss_encounters%ROWTYPE;
  v_encounter public.dungeon_encounters%ROWTYPE; v_save public.player_saves%ROWTYPE;
  v_request jsonb := jsonb_build_object('encounter_id', p_encounter_id, 'expected_revision', p_expected_revision);
  v_state jsonb; v_chest jsonb; v_result jsonb; v_revision bigint; v_gold bigint;
  v_now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  v_day text := to_char(public.heroloop_game_date(now()), 'YYYY-MM-DD'); v_last_day text;
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
  v_state := v_save.state;
  v_last_day := to_char(public.heroloop_game_date(to_timestamp(COALESCE((v_state->>'lastChestReset')::numeric, v_now_ms) / 1000)), 'YYYY-MM-DD');
  IF v_last_day IS DISTINCT FROM v_day THEN
    v_state := jsonb_set(jsonb_set(v_state, '{chestsOpenedToday}', '0'::jsonb), '{lastChestReset}', to_jsonb(v_now_ms), true);
  END IF;
  IF COALESCE((v_state->>'chestsOpenedToday')::integer, 0) >= 1000 THEN RAISE EXCEPTION 'daily_chest_limit_reached'; END IF;
  v_chest := jsonb_build_object('stage', v_boss.location_id, 'boss', true);
  v_gold := public.boss_hunt_gold_reward_with_account(v_boss.location_id, v_encounter.roster_snapshot,
    (public.account_reward_bonus(p_player_id)->>'gold')::numeric);
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
  PERFORM public.mail_deliver_reward(p_player_id, 'chest', v_chest, 'boss_reward', v_boss.id::text);
  UPDATE public.players SET boss_kills = COALESCE(boss_kills, 0) + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.boss_encounters SET status = 'claimed', completed_at = now() WHERE id = v_boss.id;
  UPDATE public.dungeon_encounters SET status = 'completed', revision = revision + 1, completed_at = now()
  WHERE id = v_encounter.id RETURNING * INTO v_encounter;
  v_result := jsonb_build_object('encounter_id', v_encounter.id, 'boss_encounter_id', v_boss.id,
    'status', 'completed', 'revision', v_encounter.revision, 'boss_chest', v_chest, 'chest_delivered_to', 'mail', 'gold', v_gold,
    'gold_source_key', 'boss-gold:' || v_boss.id::text,
    'state', v_state, 'save_revision', v_revision, 'reward_settled', true);
  INSERT INTO public.boss_claim_events(idempotency_key, player_id, boss_encounter_id, request, result)
  VALUES (p_idempotency_key, p_player_id, v_boss.id, v_request, v_result);
  RETURN v_result;
END;
$function$;

COMMIT;
