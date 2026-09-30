\set ON_ERROR_STOP on

-- Promo codes in the Founder panel (HL-TASK-20260930215246-E0E7AD). The Founder
-- creates, edits and deletes codes: dates, a global use limit, an optional
-- single target player and a capped reward of Gold, $HERO, Summon Scrolls,
-- Boss Keys, chests and potions. Redemption stays server-only and atomic in
-- public.redeem_promo_code; the panel never touches a save.
--
-- The code text is kept for the Founder's list (founder decision 2026-09-30,
-- superseding the plaintext-once rule of promo-management-proposal.md); only
-- admin.promo_code_list returns it, and the game API still looks codes up by
-- hash. Once a code has been redeemed its text, target and reward are locked
-- so every player gets what the code promised; delete then archives the row
-- instead of removing redemption evidence.

ALTER TABLE public.promo_codes
  ADD COLUMN IF NOT EXISTS code_text text CONSTRAINT promo_codes_code_text CHECK (code_text IS NULL OR code_text ~ '^[A-Z0-9]{4,24}$'),
  ADD COLUMN IF NOT EXISTS player_id uuid REFERENCES public.players(player_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS promo_codes_listed ON public.promo_codes(created_at DESC) WHERE deleted_at IS NULL;

-- Potions enter the resource ledger under their own source key. A panel-only
-- fixture database has no resource ledger; every game database does.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  IF to_regclass('public.resource_catalog') IS NULL THEN RETURN; END IF;
  v_def := pg_get_functiondef('public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)'::regprocedure);
  IF position('''promo_potion''' IN v_def) = 0 THEN
    v_new := replace(v_def, $f$'item_salvage_material','item_craft_material'$f$, $f$'item_salvage_material','item_craft_material','promo_potion'$f$);
    IF v_new = v_def THEN RAISE EXCEPTION 'promo_potion_resource_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
  v_def := pg_get_functiondef('public.resource_ledger_reconciliation()'::regprocedure);
  IF position('''promo_potion''' IN v_def) = 0 THEN
    v_new := replace(v_def, $f$'item_salvage_material','item_craft_material'$f$, $f$'item_salvage_material','item_craft_material','promo_potion'$f$);
    IF v_new = v_def THEN RAISE EXCEPTION 'promo_potion_reconciliation_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END
$$;

-- Reward shape: {gold, hero, summon_scrolls, boss_keys, chests, potion_xs..potion_xxl}.
-- The panel caps match Partner Quests; the key names stay those the
-- redemption result and its ledger triggers already use.
CREATE OR REPLACE FUNCTION public.promo_code_reward_valid(p_reward jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_typeof(p_reward) = 'object'
    AND p_reward <> '{}'::jsonb
    AND p_reward - ARRAY['gold','hero','summon_scrolls','boss_keys','chests','potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl'] = '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_reward) r
      WHERE jsonb_typeof(r.value) <> 'number' OR (r.value #>> '{}') !~ '^[0-9]+$' OR (r.value #>> '{}')::numeric <= 0
        OR (r.value #>> '{}')::numeric > CASE r.key
          WHEN 'gold' THEN 10000000 WHEN 'hero' THEN 10000 WHEN 'summon_scrolls' THEN 100
          WHEN 'boss_keys' THEN 100 WHEN 'chests' THEN 50 ELSE 1000 END
    );
$function$;

CREATE OR REPLACE FUNCTION public.redeem_promo_code(
  p_player_id uuid,
  p_code_hash text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code public.promo_codes%ROWTYPE;
  v_existing public.promo_code_redemptions%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_result jsonb;
  v_rewards jsonb;
  v_gold bigint;
  v_hero numeric;
  v_scrolls bigint;
  v_boss_keys bigint;
  v_chests integer;
  v_stage integer;
  v_potions jsonb := '{}'::jsonb;
  v_tier text;
  v_amount bigint;
  v_balance numeric;
  v_revision bigint;
BEGIN
  IF p_code_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_promo_code'; END IF;

  SELECT * INTO v_code FROM public.promo_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR NOT v_code.active OR v_code.deleted_at IS NOT NULL OR v_code.starts_at > now()
    OR (v_code.ends_at IS NOT NULL AND v_code.ends_at <= now())
    OR (v_code.player_id IS NOT NULL AND v_code.player_id <> p_player_id) THEN
    RAISE EXCEPTION 'invalid_promo_code';
  END IF;

  SELECT * INTO v_existing
  FROM public.promo_code_redemptions
  WHERE promo_code_id = v_code.id AND player_id = p_player_id;
  IF FOUND THEN
    IF v_existing.idempotency_key = p_idempotency_key THEN
      RETURN v_existing.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'promo_code_already_redeemed';
  END IF;

  IF v_code.max_redemptions IS NOT NULL AND v_code.redemption_count >= v_code.max_redemptions THEN
    RAISE EXCEPTION 'promo_code_exhausted';
  END IF;

  IF v_code.rewards - ARRAY['gold','hero','summon_scrolls','boss_keys','chests','potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_promo_rewards';
  END IF;

  BEGIN
    v_gold := COALESCE((v_code.rewards->>'gold')::bigint, 0);
    v_hero := COALESCE((v_code.rewards->>'hero')::numeric, 0);
    v_scrolls := COALESCE((v_code.rewards->>'summon_scrolls')::bigint, 0);
    v_boss_keys := COALESCE((v_code.rewards->>'boss_keys')::bigint, 0);
    v_chests := COALESCE((v_code.rewards->>'chests')::integer, 0);
    FOREACH v_tier IN ARRAY ARRAY['xs','sm','md','lg','xl','xxl'] LOOP
      v_amount := COALESCE((v_code.rewards->>('potion_' || v_tier))::bigint, 0);
      IF v_amount < 0 OR v_amount > 1000 THEN RAISE EXCEPTION 'invalid_promo_rewards'; END IF;
      IF v_amount > 0 THEN v_potions := v_potions || jsonb_build_object(v_tier, v_amount); END IF;
    END LOOP;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid_promo_rewards';
  END;

  IF v_gold < 0 OR v_gold > 1000000000 OR v_hero < 0 OR v_hero > 1000000000
    OR v_scrolls < 0 OR v_scrolls > 10000 OR v_boss_keys < 0 OR v_boss_keys > 10000
    OR v_chests < 0 OR v_chests > 50
    OR v_gold + v_hero + v_scrolls + v_boss_keys + v_chests + (SELECT count(*) FROM jsonb_object_keys(v_potions)) <= 0
    OR v_hero <> trunc(v_hero) THEN
    RAISE EXCEPTION 'invalid_promo_rewards';
  END IF;

  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'player_not_found'; END IF;

  v_balance := v_balance + v_hero;
  v_state := v_save.state;
  v_state := jsonb_set(v_state, '{gold}', to_jsonb(GREATEST(0, COALESCE((v_state->>'gold')::bigint, 0)) + v_gold), true);
  v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
  v_state := jsonb_set(v_state, '{summonScrolls}', to_jsonb(GREATEST(0, COALESCE((v_state->>'summonScrolls')::bigint, 0)) + v_scrolls), true);
  v_state := jsonb_set(v_state, '{bossKeys}', to_jsonb(GREATEST(0, COALESCE((v_state->>'bossKeys')::bigint, 0)) + v_boss_keys), true);
  IF v_potions <> '{}'::jsonb THEN
    -- The ledger trigger below rewrites these from authoritative balances.
    v_state := jsonb_set(v_state, '{potions}', COALESCE(v_state->'potions', '{}'::jsonb) || (
      SELECT jsonb_object_agg(p.key, GREATEST(0, COALESCE((v_state->'potions'->>p.key)::bigint, 0)) + p.value::text::bigint)
      FROM jsonb_each(v_potions) p), true);
  END IF;
  IF v_chests > 0 THEN
    IF jsonb_typeof(COALESCE(v_state->'chests', '[]'::jsonb)) <> 'array'
      OR jsonb_array_length(COALESCE(v_state->'chests', '[]'::jsonb)) + v_chests > 500 THEN
      RAISE EXCEPTION 'chest_capacity_exceeded';
    END IF;
    v_stage := GREATEST(1, COALESCE((v_state->>'highestLocation')::integer, 1));
    v_state := jsonb_set(v_state, '{chests}', COALESCE(v_state->'chests', '[]'::jsonb) ||
      (SELECT jsonb_agg(jsonb_build_object('stage', v_stage)) FROM generate_series(1, v_chests)), true);
  END IF;

  UPDATE public.players SET token_balance = v_balance, updated_at = now() WHERE player_id = p_player_id;
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.promo_codes SET redemption_count = redemption_count + 1 WHERE id = v_code.id;

  v_rewards := jsonb_build_object('gold', v_gold, 'hero', v_hero, 'summon_scrolls', v_scrolls, 'boss_keys', v_boss_keys);
  IF v_chests > 0 THEN v_rewards := v_rewards || jsonb_build_object('chests', v_chests); END IF;
  IF v_potions <> '{}'::jsonb THEN v_rewards := v_rewards || jsonb_build_object('potions', v_potions); END IF;
  v_result := jsonb_build_object(
    'label', v_code.label,
    'rewards', v_rewards,
    'state', v_state,
    'revision', v_revision,
    'token_balance', v_balance,
    'replayed', false
  );
  INSERT INTO public.promo_code_redemptions (promo_code_id, player_id, idempotency_key, result)
  VALUES (v_code.id, p_player_id, p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

-- Scrolls, keys and now potions from a redemption enter the resource ledger.
DO $$
BEGIN
  IF to_regclass('public.resource_catalog') IS NULL THEN RETURN; END IF;
  EXECUTE $trigger$
CREATE OR REPLACE FUNCTION public.resource_promo_redemption_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $body$
DECLARE
  v_scrolls bigint := COALESCE((NEW.result#>>'{rewards,summon_scrolls}')::bigint, 0);
  v_boss_keys bigint := COALESCE((NEW.result#>>'{rewards,boss_keys}')::bigint, 0);
  v_potions jsonb := COALESCE(NEW.result#>'{rewards,potions}', '{}'::jsonb);
  v_entries jsonb := '[]'::jsonb;
  v_resource jsonb;
  v_hash text;
  v_tier text;
BEGIN
  IF v_scrolls > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'resource_id', 'summon_scroll', 'delta', v_scrolls::text, 'source_key', 'promo_summon_scroll'));
  END IF;
  IF v_boss_keys > 0 THEN
    v_entries := v_entries || jsonb_build_array(jsonb_build_object(
      'resource_id', 'boss_key', 'delta', v_boss_keys::text, 'source_key', 'promo_boss_key'));
  END IF;
  FOREACH v_tier IN ARRAY ARRAY['xs','sm','md','lg','xl','xxl'] LOOP
    IF COALESCE((v_potions->>v_tier)::bigint, 0) > 0 THEN
      v_entries := v_entries || jsonb_build_array(jsonb_build_object(
        'resource_id', 'potion_' || v_tier, 'delta', v_potions->>v_tier, 'source_key', 'promo_potion'));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_entries) = 0 THEN RETURN NEW; END IF;
  v_hash := encode(extensions.digest(jsonb_build_object(
    'promo_code_id', NEW.promo_code_id, 'resources', v_entries)::text, 'sha256'), 'hex');
  v_resource := public.apply_resource_entries(NEW.player_id, NEW.idempotency_key, 'promo_code', v_hash,
    v_entries, (NEW.result->>'revision')::bigint);
  UPDATE public.players SET boss_keys = (v_resource#>>'{balances,boss_key}')::integer, updated_at = now()
  WHERE player_id = NEW.player_id;
  UPDATE public.player_saves SET state = jsonb_set(jsonb_set(jsonb_set(state,
      '{bossKeys}', to_jsonb((v_resource#>>'{balances,boss_key}')::bigint), true),
      '{summonScrolls}', to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint), true),
      '{potions}', COALESCE(state->'potions', '{}'::jsonb) || jsonb_build_object(
        'xs', (v_resource#>>'{balances,potion_xs}')::bigint, 'sm', (v_resource#>>'{balances,potion_sm}')::bigint,
        'md', (v_resource#>>'{balances,potion_md}')::bigint, 'lg', (v_resource#>>'{balances,potion_lg}')::bigint,
        'xl', (v_resource#>>'{balances,potion_xl}')::bigint, 'xxl', (v_resource#>>'{balances,potion_xxl}')::bigint), true),
    updated_at = now()
  WHERE player_id = NEW.player_id;
  RETURN NEW;
END;
$body$;
$trigger$;
  REVOKE ALL ON FUNCTION public.resource_promo_redemption_trigger() FROM PUBLIC;
END
$$;

-- Admin: founder-only helpers behind the Promo codes screen.
CREATE OR REPLACE FUNCTION admin.promo_code_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND status = 'active' AND role = 'founder') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

-- A target player is a player id or an exact (case-insensitive) username.
CREATE OR REPLACE FUNCTION admin.promo_code_resolve_player(p_player text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_value text := NULLIF(btrim(COALESCE(p_player, '')), '');
  v_ids uuid[];
BEGIN
  IF v_value IS NULL THEN RETURN NULL; END IF;
  IF v_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT array_agg(player_id) INTO v_ids FROM public.players WHERE player_id = v_value::uuid;
  ELSE
    SELECT array_agg(player_id) INTO v_ids FROM (
      SELECT player_id FROM public.players WHERE lower(username) = lower(v_value) LIMIT 2) found;
  END IF;
  IF COALESCE(cardinality(v_ids), 0) = 0 THEN RAISE EXCEPTION 'promo_player_unknown' USING ERRCODE = '22023'; END IF;
  IF cardinality(v_ids) > 1 THEN RAISE EXCEPTION 'promo_player_ambiguous' USING ERRCODE = '22023'; END IF;
  RETURN v_ids[1];
END
$function$;

-- Create (p_id NULL) or edit a code. After the first redemption the code
-- text, target player and reward are locked; label, window, limit and the
-- on/off switch stay editable (the limit never below the uses so far).
CREATE OR REPLACE FUNCTION admin.promo_code_save(p_actor uuid, p_id uuid, p_code jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE
  v_existing public.promo_codes%ROWTYPE;
  v_text text;
  v_hash text;
  v_player uuid;
  v_starts timestamptz;
  v_ends timestamptz;
  v_max integer;
  v_label text;
  v_active boolean;
  v_id uuid;
BEGIN
  PERFORM admin.promo_code_founder(p_actor);
  IF jsonb_typeof(p_code) <> 'object' THEN RAISE EXCEPTION 'invalid_promo_code_input' USING ERRCODE = '22023'; END IF;
  IF NOT public.promo_code_reward_valid(p_code->'rewards') THEN RAISE EXCEPTION 'invalid_promo_reward' USING ERRCODE = '22023'; END IF;
  v_text := upper(regexp_replace(btrim(COALESCE(p_code->>'code', '')), '[ -]+', '', 'g'));
  IF v_text !~ '^[A-Z0-9]{4,24}$' THEN RAISE EXCEPTION 'invalid_promo_code_text' USING ERRCODE = '22023'; END IF;
  v_hash := encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex');
  v_player := admin.promo_code_resolve_player(p_code->>'player');
  v_label := btrim(COALESCE(p_code->>'label', ''));
  v_active := COALESCE((p_code->>'active')::boolean, true);
  BEGIN
    v_starts := COALESCE((p_code->>'starts_at')::timestamptz, now());
    v_ends := (p_code->>'ends_at')::timestamptz;
    v_max := (p_code->>'max_redemptions')::integer;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid_promo_code_input' USING ERRCODE = '22023';
  END;
  -- Every value-bearing code has a finite global limit.
  IF char_length(v_label) NOT BETWEEN 1 AND 80 OR v_max IS NULL OR v_max NOT BETWEEN 1 AND 1000000
    OR (v_ends IS NOT NULL AND v_ends <= v_starts) THEN
    RAISE EXCEPTION 'invalid_promo_code_input' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.promo_codes WHERE code_hash = v_hash) THEN
      RAISE EXCEPTION 'promo_code_taken' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.promo_codes(code_hash, code_text, label, rewards, active, starts_at, ends_at, max_redemptions, player_id, created_by)
    VALUES (v_hash, v_text, v_label, p_code->'rewards', v_active, v_starts, v_ends, v_max, v_player, p_actor)
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_existing FROM public.promo_codes WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'promo_code_unknown' USING ERRCODE = '22023'; END IF;
    IF v_existing.redemption_count > 0 AND (v_existing.code_hash <> v_hash OR v_existing.rewards <> p_code->'rewards'
      OR v_existing.player_id IS DISTINCT FROM v_player) THEN
      RAISE EXCEPTION 'promo_code_locked' USING ERRCODE = '22023';
    END IF;
    IF v_max < v_existing.redemption_count THEN RAISE EXCEPTION 'promo_code_limit_below_uses' USING ERRCODE = '22023'; END IF;
    IF v_existing.code_hash <> v_hash AND EXISTS (SELECT 1 FROM public.promo_codes WHERE code_hash = v_hash) THEN
      RAISE EXCEPTION 'promo_code_taken' USING ERRCODE = '22023';
    END IF;
    UPDATE public.promo_codes SET code_hash = v_hash, code_text = v_text, label = v_label, rewards = p_code->'rewards',
      active = v_active, starts_at = v_starts, ends_at = v_ends, max_redemptions = v_max, player_id = v_player, updated_at = now()
    WHERE id = p_id;
    v_id := p_id;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'code', v_text);
END
$function$;

-- Delete: a code nobody redeemed is removed; a redeemed one is archived
-- (switched off and hidden) so redemption and ledger evidence stay intact.
CREATE OR REPLACE FUNCTION admin.promo_code_delete(p_actor uuid, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE v_code public.promo_codes%ROWTYPE;
BEGIN
  PERFORM admin.promo_code_founder(p_actor);
  SELECT * INTO v_code FROM public.promo_codes WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'promo_code_unknown' USING ERRCODE = '22023'; END IF;
  IF v_code.redemption_count = 0 AND NOT EXISTS (SELECT 1 FROM public.promo_code_redemptions WHERE promo_code_id = p_id) THEN
    DELETE FROM public.promo_codes WHERE id = p_id;
    RETURN jsonb_build_object('id', p_id, 'deleted', 'removed');
  END IF;
  UPDATE public.promo_codes SET active = false, deleted_at = now(), updated_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'deleted', 'archived');
END
$function$;

-- Panel read: every listed code with its state and the target player's name.
-- Codes made before this screen have no stored text and show only the label.
CREATE OR REPLACE FUNCTION admin.promo_code_list(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
BEGIN
  PERFORM admin.promo_code_founder(p_actor);
  RETURN jsonb_build_object(
    'as_of', now(),
    'codes', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', c.id, 'code', c.code_text, 'label', c.label, 'rewards', c.rewards, 'active', c.active,
      'starts_at', c.starts_at, 'ends_at', c.ends_at, 'max_redemptions', c.max_redemptions,
      'redemption_count', c.redemption_count, 'player_id', c.player_id, 'player_name', p.username,
      'created_at', c.created_at, 'updated_at', c.updated_at,
      'state', CASE
        WHEN NOT c.active THEN 'off'
        WHEN c.ends_at IS NOT NULL AND c.ends_at <= now() THEN 'expired'
        WHEN c.max_redemptions IS NOT NULL AND c.redemption_count >= c.max_redemptions THEN 'exhausted'
        WHEN c.starts_at > now() THEN 'scheduled'
        ELSE 'live' END
    ) ORDER BY c.created_at DESC, c.id)
    FROM public.promo_codes c LEFT JOIN public.players p ON p.player_id = c.player_id
    WHERE c.deleted_at IS NULL), '[]'::jsonb)
  );
END
$function$;

DO $audit_kinds$
DECLARE
  v_constraint text;
  v_kinds text[];
BEGIN
  -- The constraint prints either as ARRAY['a'::text, ...] or, once rewritten
  -- by an earlier migration, as '{a,b,...}'::text[]; this reads both.
  SELECT conname, ARRAY(SELECT m[1] FROM regexp_matches(pg_get_constraintdef(oid), '[''{,]\s*"?([a-z_]+)"?\s*(?=[''},])', 'g') m)
  INTO v_constraint, v_kinds
  FROM pg_constraint
  WHERE conrelid = 'admin.audit_log'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%event_kind%';
  IF v_constraint IS NULL OR cardinality(v_kinds) < 5 THEN RAISE EXCEPTION 'audit_kind_constraint_missing'; END IF;
  IF NOT 'promo_code' = ANY(v_kinds) THEN v_kinds := array_append(v_kinds, 'promo_code'); END IF;
  EXECUTE format('ALTER TABLE admin.audit_log DROP CONSTRAINT %I', v_constraint);
  EXECUTE format('ALTER TABLE admin.audit_log ADD CONSTRAINT audit_log_event_kind_check CHECK (event_kind = ANY (%L::text[]))', v_kinds);
END
$audit_kinds$;

REVOKE ALL ON FUNCTION public.redeem_promo_code(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promo_code_reward_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.promo_code_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.promo_code_resolve_player(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.promo_code_save(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.promo_code_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.promo_code_list(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin.promo_code_save(uuid, uuid, jsonb) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.promo_code_delete(uuid, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.promo_code_list(uuid) TO heroloop_admin;
