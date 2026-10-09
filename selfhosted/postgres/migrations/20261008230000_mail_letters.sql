-- Founder 2026-10-08: the Mailbox holds letters. Every letter shares one template: who sent it, a title, a text
-- and its attached rewards (Boss Hunt rewards, compensation, an administrator's greeting with Gold, ...).
-- Opening a letter shows the text and the attachments; Claim takes every attachment that fits (Gold always,
-- a chest only while the 500-chest queue has room) and the rest stay attached. A letter without attachments
-- is claimed to mark it read. Opening a letter marks it read (shown grey); "Delete read" removes read letters
-- with nothing left attached. Market items keep their own Mailbox rows (player_mail_items).
BEGIN;

CREATE TABLE IF NOT EXISTS public.player_mail_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('boss_reward', 'compensation', 'admin', 'system')),
  sender text NOT NULL CHECK (char_length(sender) BETWEEN 1 AND 60),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) <= 2000),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  claimed_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS player_mail_letters_open_player
  ON public.player_mail_letters(player_id, created_at, id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_mail_letters_source_once
  ON public.player_mail_letters(player_id, source, source_ref) WHERE source_ref IS NOT NULL;
ALTER TABLE public.player_mail_letters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_mail_letters FROM PUBLIC;

-- Attachments are the existing reward rows, now owned by a letter; Gold joins chests.
ALTER TABLE public.player_mail_rewards ADD COLUMN IF NOT EXISTS letter_id uuid REFERENCES public.player_mail_letters(id) ON DELETE CASCADE;
ALTER TABLE public.player_mail_rewards DROP CONSTRAINT IF EXISTS player_mail_rewards_kind_check;
ALTER TABLE public.player_mail_rewards ADD CONSTRAINT player_mail_rewards_kind_check CHECK (kind IN ('chest', 'gold'));
ALTER TABLE public.player_mail_rewards DROP CONSTRAINT IF EXISTS player_mail_rewards_source_check;
ALTER TABLE public.player_mail_rewards ADD CONSTRAINT player_mail_rewards_source_check CHECK (source IN ('boss_reward', 'compensation', 'admin', 'system'));
DROP INDEX IF EXISTS public.player_mail_rewards_source_once;
CREATE INDEX IF NOT EXISTS player_mail_rewards_letter ON public.player_mail_rewards(letter_id);

-- One attachment: {"kind":"chest","stage":1-20,"boss":bool} or {"kind":"gold","amount":1..1e12}.
CREATE OR REPLACE FUNCTION public.mail_attachment_payload(p_attachment jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF jsonb_typeof(p_attachment) <> 'object' THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
  IF p_attachment->>'kind' = 'chest' THEN
    IF jsonb_typeof(p_attachment->'stage') <> 'number' OR (p_attachment->>'stage')::numeric NOT BETWEEN 1 AND 20
      OR (p_attachment->>'stage')::numeric <> trunc((p_attachment->>'stage')::numeric) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('stage', (p_attachment->>'stage')::integer, 'boss', COALESCE((p_attachment->>'boss')::boolean, false));
  ELSIF p_attachment->>'kind' = 'gold' THEN
    IF jsonb_typeof(p_attachment->'amount') <> 'number' OR (p_attachment->>'amount')::numeric NOT BETWEEN 1 AND 1000000000000
      OR (p_attachment->>'amount')::numeric <> trunc((p_attachment->>'amount')::numeric) THEN RAISE EXCEPTION 'invalid_mail_attachment'; END IF;
    RETURN jsonb_build_object('amount', (p_attachment->>'amount')::bigint);
  END IF;
  RAISE EXCEPTION 'invalid_mail_attachment';
END
$function$;

-- The one way to send a letter: server code, compensation and (later) the administrator broadcast use it.
CREATE OR REPLACE FUNCTION public.mail_send_letter(p_player_id uuid, p_source text, p_sender text, p_title text,
  p_body text, p_source_ref text, p_attachments jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_id uuid; v_attachment jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_attachments, '[]'::jsonb)) <> 'array' OR jsonb_array_length(COALESCE(p_attachments, '[]'::jsonb)) > 20 THEN
    RAISE EXCEPTION 'invalid_mail_attachment';
  END IF;
  INSERT INTO public.player_mail_letters(player_id, source, sender, title, body, source_ref)
    VALUES (p_player_id, p_source, p_sender, p_title, COALESCE(p_body, ''), left(p_source_ref, 80))
    RETURNING id INTO v_id;
  FOR v_attachment IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) LOOP
    INSERT INTO public.player_mail_rewards(player_id, kind, payload, source, letter_id)
      VALUES (p_player_id, v_attachment->>'kind', public.mail_attachment_payload(v_attachment), p_source, v_id);
  END LOOP;
  RETURN v_id;
END
$function$;
REVOKE ALL ON FUNCTION public.mail_send_letter(uuid,text,text,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mail_attachment_payload(jsonb) FROM PUBLIC;

-- Reward rows sent before letters existed each become a Boss Hunt letter.
DO $backfill$
DECLARE v_reward public.player_mail_rewards%ROWTYPE; v_letter uuid;
BEGIN
  FOR v_reward IN SELECT * FROM public.player_mail_rewards WHERE letter_id IS NULL ORDER BY created_at, id LOOP
    INSERT INTO public.player_mail_letters(player_id, source, sender, title, body, source_ref, created_at, read_at, claimed_at, deleted_at)
      VALUES (v_reward.player_id, v_reward.source, 'Boss Hunt', 'Boss Hunt reward',
        'Your party won a Boss Hunt. The Boss Chest is attached.', 'reward:' || v_reward.id::text, v_reward.created_at,
        v_reward.claimed_at, v_reward.claimed_at, v_reward.claimed_at)
      RETURNING id INTO v_letter;
    UPDATE public.player_mail_rewards SET letter_id = v_letter WHERE id = v_reward.id;
  END LOOP;
END
$backfill$;

CREATE OR REPLACE FUNCTION public.mail_letters_json(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', letter.id, 'source', letter.source, 'sender', letter.sender, 'title', letter.title, 'body', letter.body,
      'created_at', letter.created_at, 'read', letter.read_at IS NOT NULL, 'claimed', letter.claimed_at IS NOT NULL,
      'attachments', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', reward.id, 'kind', reward.kind, 'payload', reward.payload, 'claimed', reward.claimed_at IS NOT NULL)
          ORDER BY reward.created_at, reward.id)
        FROM public.player_mail_rewards reward WHERE reward.letter_id = letter.id
      ), '[]'::jsonb)
    ) ORDER BY letter.created_at DESC, letter.id), '[]'::jsonb)
  FROM (
    SELECT * FROM public.player_mail_letters
    WHERE player_id = p_player_id AND deleted_at IS NULL
    ORDER BY created_at DESC, id LIMIT 100
  ) letter
$function$;
REVOKE ALL ON FUNCTION public.mail_letters_json(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heroloop_api.mail_list(p_player_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL)
      + (SELECT count(*) FROM public.player_mail_letters WHERE player_id = p_player_id AND deleted_at IS NULL
          AND (read_at IS NULL OR claimed_at IS NULL)),
    'letters', public.mail_letters_json(p_player_id),
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

-- p_mail_id: a Market item row, a letter (claims its attachments) or NULL (everything that fits).
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
  v_gold bigint := 0;
  v_reward public.player_mail_rewards%ROWTYPE;
  v_letter public.player_mail_letters%ROWTYPE;
  v_items_full boolean := false;
  v_chests_full boolean := false;
  v_is_letter boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.player_mail_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    -- The receipt keeps counts only; a replay returns the current canonical bag, chests and Gold.
    RETURN (v_existing.result - 'inventory' - 'chests' - 'gold') || COALESCE((
      SELECT jsonb_build_object('inventory', COALESCE(state->'inventory', '[]'::jsonb), 'chests', COALESCE(state->'chests', '[]'::jsonb),
        'gold', COALESCE((state->>'gold')::bigint, 0))
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
    v_is_letter := EXISTS (SELECT 1 FROM public.player_mail_letters WHERE id = p_mail_id AND player_id = p_player_id AND deleted_at IS NULL);
    IF NOT v_is_letter AND NOT EXISTS (
      SELECT 1 FROM public.player_mail_items WHERE id = p_mail_id AND player_id = p_player_id AND claimed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'mail_not_found';
    END IF;
  END IF;

  FOR v_mail IN
    SELECT * FROM public.player_mail_items
    WHERE player_id = p_player_id AND claimed_at IS NULL AND NOT v_is_letter AND (p_mail_id IS NULL OR id = p_mail_id)
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

  -- Letters: Gold always lands; a chest lands only while the 500-chest queue has room. A letter closes when
  -- nothing stays attached (a text-only letter closes on its first claim).
  FOR v_letter IN
    SELECT * FROM public.player_mail_letters
    WHERE player_id = p_player_id AND claimed_at IS NULL AND deleted_at IS NULL AND (p_mail_id IS NULL OR id = p_mail_id)
      AND (p_mail_id IS NULL OR v_is_letter)
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    FOR v_reward IN
      SELECT * FROM public.player_mail_rewards WHERE letter_id = v_letter.id AND claimed_at IS NULL ORDER BY created_at, id FOR UPDATE
    LOOP
      IF v_reward.kind = 'chest' THEN
        IF jsonb_array_length(v_chests) >= 500 THEN v_chests_full := true; CONTINUE; END IF;
        v_chests := v_chests || jsonb_build_array(v_reward.payload);
      ELSIF v_reward.kind = 'gold' THEN
        v_gold := v_gold + (v_reward.payload->>'amount')::bigint;
      END IF;
      UPDATE public.player_mail_rewards SET claimed_at = now(), outcome = 'claimed' WHERE id = v_reward.id;
      v_claimed := v_claimed + 1;
      v_changed := true;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.player_mail_rewards WHERE letter_id = v_letter.id AND claimed_at IS NULL) THEN
      UPDATE public.player_mail_letters SET claimed_at = now(), read_at = COALESCE(read_at, now()) WHERE id = v_letter.id;
      v_changed := true;
    END IF;
  END LOOP;
  -- Claim all with a full bag and nothing else to take keeps its old answer.
  IF p_mail_id IS NULL AND v_claimed = 0 AND v_items_full AND NOT v_chests_full THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;

  IF v_changed THEN
    v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
    v_state := jsonb_set(v_state, '{chests}', v_chests, true);
    IF v_gold > 0 THEN
      v_state := jsonb_set(v_state, '{gold}', to_jsonb(COALESCE((v_state->>'gold')::bigint, 0) + v_gold), true);
      v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold), true);
    END IF;
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  END IF;
  SELECT (SELECT count(*) FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL)
    + (SELECT count(*) FROM public.player_mail_letters WHERE player_id = p_player_id AND deleted_at IS NULL
        AND (read_at IS NULL OR claimed_at IS NULL)) INTO v_remaining;
  v_result := jsonb_build_object('claimed', v_claimed, 'remaining', v_remaining, 'revision', v_revision,
    'items_full', v_items_full, 'chests_full', v_chests_full, 'gold_claimed', v_gold);
  INSERT INTO public.player_mail_claim_events(idempotency_key, player_id, request, result)
    VALUES (p_idempotency_key, p_player_id, v_request, v_result);
  RETURN v_result || jsonb_build_object('inventory', v_inventory, 'chests', v_chests, 'gold', COALESCE((v_state->>'gold')::bigint, 0));
END
$function$;
REVOKE ALL ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) TO heroloop_api;

-- Opening a letter marks it read; repeating is harmless.
CREATE OR REPLACE FUNCTION heroloop_api.mail_read(p_player_id uuid, p_letter_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
BEGIN
  UPDATE public.player_mail_letters SET read_at = COALESCE(read_at, now())
    WHERE id = p_letter_id AND player_id = p_player_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'mail_not_found'; END IF;
  RETURN heroloop_api.mail_list(p_player_id) - 'items';
END
$function$;
REVOKE ALL ON FUNCTION heroloop_api.mail_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_read(uuid,uuid) TO heroloop_api;

-- "Delete read": removes read letters that have nothing left to claim; letters with rewards always stay.
CREATE OR REPLACE FUNCTION heroloop_api.mail_delete_read(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_deleted integer;
BEGIN
  UPDATE public.player_mail_letters letter SET deleted_at = now()
    WHERE letter.player_id = p_player_id AND letter.deleted_at IS NULL AND letter.read_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.player_mail_rewards reward WHERE reward.letter_id = letter.id AND reward.claimed_at IS NULL);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('deleted', v_deleted) || (heroloop_api.mail_list(p_player_id) - 'items');
END
$function$;
REVOKE ALL ON FUNCTION heroloop_api.mail_delete_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_delete_read(uuid) TO heroloop_api;

-- Boss Hunt Claim: the hunt completes at once; chest and Gold arrive as a letter.
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
  v_state := jsonb_set(v_state, '{session,goldToday}', to_jsonb(COALESCE((v_state#>>'{session,goldToday}')::bigint, 0) + v_gold), true);
  v_state := jsonb_set(v_state, '{totalBossKills}', to_jsonb(COALESCE((v_state->>'totalBossKills')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{session,bossKills}', to_jsonb(COALESCE((v_state#>>'{session,bossKills}')::bigint, 0) + 1), true);
  v_state := jsonb_set(v_state, '{dailyQuests}', public.advance_boss_quests(v_state->'dailyQuests', false), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.advance_boss_quests(v_state->'milestoneQuests', true), true);
  v_state := jsonb_set(v_state, '{milestoneQuests}', public.normal_combat_advance_quests(v_state->'milestoneQuests', 'gold-earned-', v_gold), true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  -- Founder 2026-10-08: the Boss Chest and the Boss Gold arrive as one Boss Hunt letter.
  PERFORM public.mail_send_letter(p_player_id, 'boss_reward', 'Boss Hunt',
    'Victory over ' || COALESCE(v_encounter.room_state#>>'{boss,name}', 'the Boss'),
    'Your party defeated ' || COALESCE(v_encounter.room_state#>>'{boss,name}', 'the Boss') || ' at Location ' || v_boss.location_id
      || '. Your rewards are attached: claim them when you have room for the chest.',
    v_boss.id::text,
    jsonb_build_array(v_chest || jsonb_build_object('kind', 'chest'), jsonb_build_object('kind', 'gold', 'amount', v_gold)));
  UPDATE public.players SET boss_kills = COALESCE(boss_kills, 0) + 1, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.boss_encounters SET status = 'claimed', completed_at = now() WHERE id = v_boss.id;
  UPDATE public.dungeon_encounters SET status = 'completed', revision = revision + 1, completed_at = now()
  WHERE id = v_encounter.id RETURNING * INTO v_encounter;
  v_result := jsonb_build_object('encounter_id', v_encounter.id, 'boss_encounter_id', v_boss.id,
    'status', 'completed', 'revision', v_encounter.revision, 'boss_chest', v_chest, 'chest_delivered_to', 'mail', 'gold_delivered_to', 'mail', 'gold', v_gold,
    'gold_source_key', 'boss-gold:' || v_boss.id::text,
    'state', v_state, 'save_revision', v_revision, 'reward_settled', true);
  INSERT INTO public.boss_claim_events(idempotency_key, player_id, boss_encounter_id, request, result)
  VALUES (p_idempotency_key, p_player_id, v_boss.id, v_request, v_result);
  RETURN v_result;
END;
$function$;

DROP FUNCTION IF EXISTS public.mail_deliver_reward(uuid,text,jsonb,text,text);

-- The rate limiter rejects unregistered actions, including reads.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  IF to_regprocedure('heroloop_api.consume_rate_limit(uuid,text)') IS NULL THEN RETURN; END IF;
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  IF v_definition LIKE '%''mail_read''%' THEN RETURN; END IF;
  v_updated := replace(v_definition, '(''mail_claim'',20,60),',
    '(''mail_claim'',20,60),(''mail_read'',60,60),(''mail_delete_read'',10,60),');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'mail_letters_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END
$$;

COMMIT;
