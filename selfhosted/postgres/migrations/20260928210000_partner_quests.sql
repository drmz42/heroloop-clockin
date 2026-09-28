\set ON_ERROR_STOP on

-- Partner Quests (docs/game/partner-quests-proposal.md). Time-limited promo
-- tasks: the player links an X/Telegram handle in BOOST MAX, presses Go (logged),
-- submits a proof link, a Founder (or an agent recommendation the Founder
-- accepts) approves it, and only then the player claims a server-owned reward.
-- Every step is an append-only event so completed-task claims can be audited.

CREATE TABLE public.player_social_links (
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  provider text NOT NULL CONSTRAINT player_social_links_provider CHECK (provider IN ('x', 'telegram')),
  handle text NOT NULL CONSTRAINT player_social_links_handle CHECK (handle ~ '^[A-Za-z0-9_]{1,32}$'),
  handle_norm text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, provider),
  CONSTRAINT player_social_links_unique_handle UNIQUE (provider, handle_norm)
);

CREATE TABLE public.player_social_link_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  provider text NOT NULL,
  kind text NOT NULL CONSTRAINT player_social_link_events_kind CHECK (kind IN ('linked', 'changed')),
  handle text NOT NULL,
  previous_handle text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_social_link_events_player ON public.player_social_link_events(player_id, created_at DESC);

CREATE TABLE public.partner_quests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CONSTRAINT partner_quests_kind CHECK (kind IN ('x_follow', 'x_repost', 'x_comment', 'x_post', 'tg_join', 'custom')),
  title text NOT NULL CONSTRAINT partner_quests_title CHECK (char_length(title) BETWEEN 3 AND 80),
  body text NOT NULL DEFAULT '' CONSTRAINT partner_quests_body CHECK (char_length(body) <= 400),
  partner text NOT NULL DEFAULT 'HeroLoop' CONSTRAINT partner_quests_partner CHECK (char_length(partner) BETWEEN 2 AND 40),
  target_url text NOT NULL CONSTRAINT partner_quests_target CHECK (target_url ~ '^https://[^[:space:]]+$' AND char_length(target_url) <= 300),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reward jsonb NOT NULL,
  max_approvals integer NOT NULL CONSTRAINT partner_quests_max CHECK (max_approvals BETWEEN 1 AND 100000),
  approvals_count integer NOT NULL DEFAULT 0 CONSTRAINT partner_quests_approvals CHECK (approvals_count >= 0),
  min_account_level integer NOT NULL DEFAULT 1 CONSTRAINT partner_quests_level CHECK (min_account_level BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'draft' CONSTRAINT partner_quests_status CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_quests_window CHECK (ends_at > starts_at),
  CONSTRAINT partner_quests_budget CHECK (approvals_count <= max_approvals)
);

CREATE TABLE public.partner_quest_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quest_id bigint NOT NULL REFERENCES public.partner_quests(id) ON DELETE RESTRICT,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'started'
    CONSTRAINT partner_quest_submissions_status CHECK (status IN ('started', 'pending', 'approved', 'rejected', 'claimed')),
  social_handle text,
  proof text CONSTRAINT partner_quest_submissions_proof CHECK (proof IS NULL OR char_length(proof) <= 300),
  proof_norm text,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  resubmits smallint NOT NULL DEFAULT 0,
  reviewed_at timestamptz,
  reviewer_kind text CONSTRAINT partner_quest_submissions_reviewer CHECK (reviewer_kind IS NULL OR reviewer_kind IN ('founder', 'agent')),
  reviewer_id uuid,
  review_note text CONSTRAINT partner_quest_submissions_note CHECK (review_note IS NULL OR char_length(review_note) <= 300),
  agent_verdict text CONSTRAINT partner_quest_submissions_agent CHECK (agent_verdict IS NULL OR agent_verdict IN ('looks_ok', 'suspicious', 'unverifiable')),
  agent_note text CONSTRAINT partner_quest_submissions_agent_note CHECK (agent_note IS NULL OR char_length(agent_note) <= 300),
  agent_at timestamptz,
  claim_key uuid UNIQUE,
  claimed_at timestamptz,
  claim_result jsonb,
  CONSTRAINT partner_quest_submissions_once UNIQUE (quest_id, player_id)
);
CREATE UNIQUE INDEX partner_quest_submissions_proof_once
  ON public.partner_quest_submissions(quest_id, proof_norm) WHERE proof_norm IS NOT NULL;
CREATE INDEX partner_quest_submissions_queue ON public.partner_quest_submissions(status, submitted_at);
CREATE INDEX partner_quest_submissions_player ON public.partner_quest_submissions(player_id);

CREATE TABLE public.partner_quest_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id bigint NOT NULL REFERENCES public.partner_quest_submissions(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT partner_quest_events_kind CHECK (kind IN ('started', 'submitted', 'resubmitted', 'approved', 'rejected', 'claimed', 'agent_checked')),
  actor_kind text NOT NULL CONSTRAINT partner_quest_events_actor CHECK (actor_kind IN ('player', 'founder', 'agent')),
  actor_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_quest_events_submission ON public.partner_quest_events(submission_id, id);

REVOKE ALL ON public.player_social_links, public.player_social_link_events, public.partner_quests,
  public.partner_quest_submissions, public.partner_quest_events FROM PUBLIC;
ALTER TABLE public.player_social_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_social_link_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quest_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quest_events ENABLE ROW LEVEL SECURITY;

-- Partner rewards enter the resource ledger under their own source key.
-- A panel-only fixture database has no resource ledger; every game database does.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  IF to_regclass('public.resource_catalog') IS NULL THEN RETURN; END IF;
  v_def := pg_get_functiondef('public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)'::regprocedure);
  v_new := replace(v_def, $f$'item_craft_material']$f$, $f$'item_craft_material','partner_quest_reward']$f$);
  IF v_new = v_def THEN RAISE EXCEPTION 'partner_quest_resource_patch_failed'; END IF;
  EXECUTE v_new;
  v_def := pg_get_functiondef('public.resource_ledger_reconciliation()'::regprocedure);
  v_new := replace(v_def, $f$'item_craft_material']$f$, $f$'item_craft_material','partner_quest_reward']$f$);
  IF v_new = v_def THEN RAISE EXCEPTION 'partner_quest_reconciliation_patch_failed'; END IF;
  EXECUTE v_new;
END
$$;

-- Reward shape: {gold, hero, summon_scroll, boss_key, potion_xs..potion_xxl, chests}.
CREATE OR REPLACE FUNCTION public.partner_quest_reward_valid(p_reward jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_typeof(p_reward) = 'object'
    AND p_reward <> '{}'::jsonb
    AND p_reward - ARRAY['gold','hero','summon_scroll','boss_key','potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl','chests'] = '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p_reward) r
      WHERE jsonb_typeof(r.value) <> 'number' OR (r.value #>> '{}') !~ '^[0-9]+$' OR (r.value #>> '{}')::numeric <= 0
        OR (r.value #>> '{}')::numeric > CASE r.key
          WHEN 'gold' THEN 10000000 WHEN 'hero' THEN 10000 WHEN 'summon_scroll' THEN 100
          WHEN 'boss_key' THEN 100 WHEN 'chests' THEN 50 ELSE 1000 END
    );
$function$;

CREATE OR REPLACE FUNCTION public.partner_quest_provider(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE WHEN p_kind LIKE 'x\_%' THEN 'x' WHEN p_kind = 'tg_join' THEN 'telegram' ELSE NULL END;
$function$;

ALTER TABLE public.partner_quests ADD CONSTRAINT partner_quests_reward CHECK (public.partner_quest_reward_valid(reward));

-- Player: link or change one handle. A handle belongs to one account; a change
-- is allowed once per 24 hours and is logged with the previous handle.
CREATE OR REPLACE FUNCTION heroloop_api.social_link_set(p_player_id uuid, p_provider text, p_handle text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_handle text;
  v_existing public.player_social_links%ROWTYPE;
BEGIN
  IF p_player_id IS NULL OR p_provider NOT IN ('x', 'telegram') OR p_handle IS NULL THEN RAISE EXCEPTION 'invalid_social_handle'; END IF;
  v_handle := btrim(p_handle);
  v_handle := regexp_replace(v_handle, '^https?://(www\.|mobile\.)?(x\.com|twitter\.com|t\.me|telegram\.me)/', '', 'i');
  v_handle := regexp_replace(v_handle, '^@', '');
  v_handle := regexp_replace(v_handle, '[/?#].*$', '');
  IF (p_provider = 'x' AND v_handle !~ '^[A-Za-z0-9_]{1,15}$')
    OR (p_provider = 'telegram' AND v_handle !~ '^[A-Za-z][A-Za-z0-9_]{4,31}$') THEN
    RAISE EXCEPTION 'invalid_social_handle';
  END IF;
  PERFORM 1 FROM public.players WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('social-link:' || p_provider || ':' || lower(v_handle), 0));
  IF EXISTS (SELECT 1 FROM public.player_social_links
    WHERE provider = p_provider AND handle_norm = lower(v_handle) AND player_id <> p_player_id) THEN
    RAISE EXCEPTION 'social_handle_taken';
  END IF;
  SELECT * INTO v_existing FROM public.player_social_links WHERE player_id = p_player_id AND provider = p_provider FOR UPDATE;
  IF FOUND THEN
    IF v_existing.handle_norm = lower(v_handle) THEN
      RETURN heroloop_api.social_link_list(p_player_id);
    END IF;
    IF v_existing.updated_at > now() - interval '24 hours' THEN RAISE EXCEPTION 'social_link_cooldown'; END IF;
    UPDATE public.player_social_links SET handle = v_handle, handle_norm = lower(v_handle), updated_at = now()
    WHERE player_id = p_player_id AND provider = p_provider;
    INSERT INTO public.player_social_link_events(player_id, provider, kind, handle, previous_handle)
    VALUES (p_player_id, p_provider, 'changed', v_handle, v_existing.handle);
  ELSE
    INSERT INTO public.player_social_links(player_id, provider, handle, handle_norm)
    VALUES (p_player_id, p_provider, v_handle, lower(v_handle));
    INSERT INTO public.player_social_link_events(player_id, provider, kind, handle)
    VALUES (p_player_id, p_provider, 'linked', v_handle);
  END IF;
  RETURN heroloop_api.social_link_list(p_player_id);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.social_link_list(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'x', (SELECT jsonb_build_object('handle', handle, 'linked_at', linked_at, 'changeable_at', updated_at + interval '24 hours')
      FROM public.player_social_links WHERE player_id = p_player_id AND provider = 'x'),
    'telegram', (SELECT jsonb_build_object('handle', handle, 'linked_at', linked_at, 'changeable_at', updated_at + interval '24 hours')
      FROM public.player_social_links WHERE player_id = p_player_id AND provider = 'telegram')
  );
$function$;

-- Player: active quests (plus approved ones still waiting to be claimed).
CREATE OR REPLACE FUNCTION heroloop_api.partner_quest_list(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'links', heroloop_api.social_link_list(p_player_id),
    'quests', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', q.id, 'kind', q.kind, 'title', q.title, 'body', q.body, 'partner', q.partner,
      'target_url', q.target_url, 'starts_at', q.starts_at, 'ends_at', q.ends_at, 'reward', q.reward,
      'requires', public.partner_quest_provider(q.kind), 'min_account_level', q.min_account_level,
      'full', q.approvals_count >= q.max_approvals,
      'status', s.status, 'proof', s.proof, 'review_note', CASE WHEN s.status = 'rejected' THEN s.review_note END,
      'can_resubmit', s.status = 'rejected' AND s.resubmits < 1
    ) ORDER BY q.ends_at, q.id)
    FROM public.partner_quests q
    LEFT JOIN public.partner_quest_submissions s ON s.quest_id = q.id AND s.player_id = p_player_id
    WHERE (q.status = 'active' AND now() >= q.starts_at AND now() < q.ends_at)
       OR s.status = 'approved'), '[]'::jsonb)
  );
$function$;

-- Player: pressed Go. Requires the linked handle; logs every press.
CREATE OR REPLACE FUNCTION heroloop_api.partner_quest_start(p_player_id uuid, p_quest_id bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_quest public.partner_quests%ROWTYPE;
  v_provider text;
  v_level integer;
  v_submission public.partner_quest_submissions%ROWTYPE;
BEGIN
  SELECT * INTO v_quest FROM public.partner_quests WHERE id = p_quest_id;
  IF NOT FOUND OR v_quest.status <> 'active' OR now() < v_quest.starts_at OR now() >= v_quest.ends_at THEN
    RAISE EXCEPTION 'partner_quest_unavailable';
  END IF;
  SELECT account_level INTO v_level FROM public.players WHERE player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'player_not_found'; END IF;
  IF COALESCE(v_level, 1) < v_quest.min_account_level THEN RAISE EXCEPTION 'partner_quest_level_required'; END IF;
  v_provider := public.partner_quest_provider(v_quest.kind);
  IF v_provider IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.player_social_links WHERE player_id = p_player_id AND provider = v_provider) THEN
    RAISE EXCEPTION 'social_link_required';
  END IF;
  INSERT INTO public.partner_quest_submissions(quest_id, player_id) VALUES (p_quest_id, p_player_id)
  ON CONFLICT (quest_id, player_id) DO NOTHING;
  SELECT * INTO v_submission FROM public.partner_quest_submissions WHERE quest_id = p_quest_id AND player_id = p_player_id;
  INSERT INTO public.partner_quest_events(submission_id, kind, actor_kind, actor_id)
  VALUES (v_submission.id, 'started', 'player', p_player_id);
  RETURN jsonb_build_object('quest_id', p_quest_id, 'status', v_submission.status, 'target_url', v_quest.target_url);
END
$function$;

-- Player: submit proof. X proofs must be a status of the player's own linked
-- account; one proof link can pay one account per quest.
CREATE OR REPLACE FUNCTION heroloop_api.partner_quest_submit(p_player_id uuid, p_quest_id bigint, p_proof text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_quest public.partner_quests%ROWTYPE;
  v_submission public.partner_quest_submissions%ROWTYPE;
  v_provider text;
  v_handle text;
  v_proof text := NULLIF(btrim(COALESCE(p_proof, '')), '');
  v_norm text;
  v_match text[];
  v_target_status text;
  v_kind text;
BEGIN
  SELECT * INTO v_quest FROM public.partner_quests WHERE id = p_quest_id;
  IF NOT FOUND OR v_quest.status <> 'active' OR now() < v_quest.starts_at OR now() >= v_quest.ends_at THEN
    RAISE EXCEPTION 'partner_quest_unavailable';
  END IF;
  SELECT * INTO v_submission FROM public.partner_quest_submissions
  WHERE quest_id = p_quest_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'partner_quest_not_started'; END IF;
  IF v_submission.status = 'rejected' AND v_submission.resubmits >= 1 THEN RAISE EXCEPTION 'partner_quest_final'; END IF;
  IF v_submission.status NOT IN ('started', 'rejected') THEN RAISE EXCEPTION 'partner_quest_already_submitted'; END IF;
  IF v_submission.started_at > now() - interval '15 seconds' THEN RAISE EXCEPTION 'partner_quest_too_fast'; END IF;
  v_provider := public.partner_quest_provider(v_quest.kind);
  IF v_provider IS NOT NULL THEN
    SELECT handle INTO v_handle FROM public.player_social_links WHERE player_id = p_player_id AND provider = v_provider;
    IF v_handle IS NULL THEN RAISE EXCEPTION 'social_link_required'; END IF;
  END IF;
  IF v_quest.kind IN ('x_repost', 'x_comment', 'x_post') THEN
    v_match := regexp_match(COALESCE(v_proof, ''), '^https://(www\.|mobile\.)?(x|twitter)\.com/([A-Za-z0-9_]{1,15})/status/([0-9]{5,25})([/?#].*)?$', 'i');
    IF v_match IS NULL THEN RAISE EXCEPTION 'partner_proof_invalid'; END IF;
    IF lower(v_match[3]) <> lower(v_handle) THEN RAISE EXCEPTION 'partner_proof_not_yours'; END IF;
    v_target_status := (regexp_match(v_quest.target_url, '/status/([0-9]{5,25})'))[1];
    IF v_target_status IS NOT NULL AND v_match[4] = v_target_status THEN RAISE EXCEPTION 'partner_proof_invalid'; END IF;
    v_proof := 'https://x.com/' || v_match[3] || '/status/' || v_match[4];
    v_norm := 'x:' || v_match[4];
  ELSIF v_quest.kind = 'custom' THEN
    IF v_proof IS NULL OR v_proof !~ '^https://[^[:space:]]{4,}$' OR char_length(v_proof) > 290 THEN RAISE EXCEPTION 'partner_proof_invalid'; END IF;
    v_norm := lower(v_proof);
  ELSE
    -- Follow/join quests are proven by the linked handle; the reviewer checks it.
    v_proof := NULL;
    v_norm := NULL;
  END IF;
  IF v_norm IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_quest_submissions
    WHERE quest_id = p_quest_id AND proof_norm = v_norm AND id <> v_submission.id) THEN
    RAISE EXCEPTION 'partner_proof_reused';
  END IF;
  v_kind := CASE WHEN v_submission.status = 'rejected' THEN 'resubmitted' ELSE 'submitted' END;
  UPDATE public.partner_quest_submissions SET status = 'pending', proof = v_proof, proof_norm = v_norm,
    social_handle = v_handle, submitted_at = now(),
    resubmits = resubmits + CASE WHEN v_kind = 'resubmitted' THEN 1 ELSE 0 END,
    agent_verdict = NULL, agent_note = NULL, agent_at = NULL
  WHERE id = v_submission.id;
  INSERT INTO public.partner_quest_events(submission_id, kind, actor_kind, actor_id, detail)
  VALUES (v_submission.id, v_kind, 'player', p_player_id,
    jsonb_strip_nulls(jsonb_build_object('proof', v_proof, 'handle', v_handle)));
  RETURN jsonb_build_object('quest_id', p_quest_id, 'status', 'pending');
END
$function$;

-- Player: claim an approved reward. Atomic with the save, ledgers and events.
CREATE OR REPLACE FUNCTION heroloop_api.partner_quest_claim(
  p_player_id uuid, p_idempotency_key uuid, p_quest_id bigint, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_submission public.partner_quest_submissions%ROWTYPE;
  v_quest public.partner_quests%ROWTYPE;
  v_save public.player_saves%ROWTYPE;
  v_state jsonb;
  v_reward jsonb;
  v_balance numeric;
  v_gold bigint;
  v_hero numeric;
  v_chests integer;
  v_stage integer;
  v_entries jsonb := '[]'::jsonb;
  v_resource jsonb;
  v_key text;
  v_revision bigint;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_expected_revision IS NULL THEN RAISE EXCEPTION 'invalid_partner_claim'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-claim:' || p_player_id::text, 0));
  SELECT * INTO v_submission FROM public.partner_quest_submissions WHERE claim_key = p_idempotency_key;
  IF FOUND THEN
    IF v_submission.player_id <> p_player_id OR v_submission.quest_id <> p_quest_id THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_submission.claim_result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_submission FROM public.partner_quest_submissions
  WHERE quest_id = p_quest_id AND player_id = p_player_id FOR UPDATE;
  IF NOT FOUND OR v_submission.status <> 'approved' THEN RAISE EXCEPTION 'partner_quest_not_approved'; END IF;
  SELECT * INTO v_quest FROM public.partner_quests WHERE id = p_quest_id;
  SELECT * INTO v_save FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF v_save.revision <> p_expected_revision THEN RAISE EXCEPTION 'state_conflict'; END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id FOR UPDATE;
  v_reward := v_quest.reward;
  v_state := v_save.state;
  v_gold := COALESCE((v_reward->>'gold')::bigint, 0);
  v_hero := COALESCE((v_reward->>'hero')::numeric, 0);
  v_chests := COALESCE((v_reward->>'chests')::integer, 0);

  FOREACH v_key IN ARRAY ARRAY['summon_scroll','boss_key','potion_xs','potion_sm','potion_md','potion_lg','potion_xl','potion_xxl'] LOOP
    IF v_reward ? v_key THEN
      v_entries := v_entries || jsonb_build_array(jsonb_build_object(
        'resource_id', v_key, 'delta', (v_reward->>v_key), 'source_key', 'partner_quest_reward'));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_entries) > 0 THEN
    v_resource := public.apply_resource_entries(p_player_id, p_idempotency_key, 'partner_quest_claim',
      encode(extensions.digest(('partner-quest:' || v_submission.id::text)::bytea, 'sha256'), 'hex'),
      v_entries, v_save.revision + 1);
    v_state := jsonb_set(v_state, '{summonScrolls}', to_jsonb((v_resource#>>'{balances,summon_scroll}')::bigint), true);
    v_state := jsonb_set(v_state, '{bossKeys}', to_jsonb((v_resource#>>'{balances,boss_key}')::bigint), true);
    v_state := jsonb_set(v_state, '{potions}', COALESCE(v_state->'potions', '{}'::jsonb) || jsonb_build_object(
      'xs', (v_resource#>>'{balances,potion_xs}')::bigint, 'sm', (v_resource#>>'{balances,potion_sm}')::bigint,
      'md', (v_resource#>>'{balances,potion_md}')::bigint, 'lg', (v_resource#>>'{balances,potion_lg}')::bigint,
      'xl', (v_resource#>>'{balances,potion_xl}')::bigint, 'xxl', (v_resource#>>'{balances,potion_xxl}')::bigint), true);
    UPDATE public.players SET boss_keys = (v_resource#>>'{balances,boss_key}')::integer WHERE player_id = p_player_id;
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

  IF v_gold > 0 THEN
    v_state := jsonb_set(v_state, '{gold}', to_jsonb(GREATEST(0, COALESCE((v_state->>'gold')::bigint, 0)) + v_gold), true);
    v_state := jsonb_set(v_state, '{totalGoldEarned}', to_jsonb(COALESCE((v_state->>'totalGoldEarned')::bigint, 0) + v_gold), true);
  END IF;
  IF v_hero > 0 THEN
    v_balance := v_balance + v_hero;
    v_state := jsonb_set(v_state, '{hero}', to_jsonb(v_balance), true);
    v_state := jsonb_set(v_state, '{totalTokensEarned}', to_jsonb(COALESCE((v_state->>'totalTokensEarned')::numeric, 0) + v_hero), true);
    UPDATE public.players SET token_balance = v_balance, updated_at = now() WHERE player_id = p_player_id;
    INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, metadata)
    VALUES ('player_issuance', 'partner-quest', 'partner-quest:' || v_submission.id, p_player_id, v_hero,
      jsonb_build_object('quest_id', p_quest_id));
  END IF;

  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  v_result := jsonb_build_object('quest_id', p_quest_id, 'claimed', true, 'reward', v_reward,
    'state', v_state, 'revision', v_revision, 'token_balance', v_balance, 'replayed', false);
  UPDATE public.partner_quest_submissions SET status = 'claimed', claim_key = p_idempotency_key,
    claimed_at = now(), claim_result = v_result WHERE id = v_submission.id;
  INSERT INTO public.partner_quest_events(submission_id, kind, actor_kind, actor_id, detail)
  VALUES (v_submission.id, 'claimed', 'player', p_player_id, jsonb_build_object('reward', v_reward, 'revision', v_revision));
  RETURN v_result;
END
$function$;

-- Admin: founder-only helpers behind the panel.
CREATE OR REPLACE FUNCTION admin.partner_quest_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND status = 'active' AND role = 'founder') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

-- Create (p_id NULL) or edit a quest. An active or ended quest keeps its
-- kind, target and reward; only a draft or paused quest can change them.
CREATE OR REPLACE FUNCTION admin.partner_quest_save(p_actor uuid, p_id bigint, p_quest jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE
  v_existing public.partner_quests%ROWTYPE;
  v_id bigint;
BEGIN
  PERFORM admin.partner_quest_founder(p_actor);
  IF jsonb_typeof(p_quest) <> 'object' OR NOT public.partner_quest_reward_valid(p_quest->'reward') THEN
    RAISE EXCEPTION 'invalid_partner_quest' USING ERRCODE = '22023';
  END IF;
  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO public.partner_quests(kind, title, body, partner, target_url, starts_at, ends_at, reward,
        max_approvals, min_account_level, created_by)
      VALUES (p_quest->>'kind', p_quest->>'title', COALESCE(p_quest->>'body', ''), COALESCE(p_quest->>'partner', 'HeroLoop'),
        p_quest->>'target_url', (p_quest->>'starts_at')::timestamptz, (p_quest->>'ends_at')::timestamptz, p_quest->'reward',
        (p_quest->>'max_approvals')::integer, COALESCE((p_quest->>'min_account_level')::integer, 1), p_actor)
      RETURNING id INTO v_id;
    ELSE
      SELECT * INTO v_existing FROM public.partner_quests WHERE id = p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'partner_quest_unknown' USING ERRCODE = '22023'; END IF;
      IF v_existing.status IN ('active', 'ended') AND (v_existing.kind <> p_quest->>'kind'
        OR v_existing.target_url <> p_quest->>'target_url' OR v_existing.reward <> p_quest->'reward') THEN
        RAISE EXCEPTION 'partner_quest_locked' USING ERRCODE = '22023';
      END IF;
      UPDATE public.partner_quests SET kind = p_quest->>'kind', title = p_quest->>'title',
        body = COALESCE(p_quest->>'body', ''), partner = COALESCE(p_quest->>'partner', 'HeroLoop'),
        target_url = p_quest->>'target_url', starts_at = (p_quest->>'starts_at')::timestamptz,
        ends_at = (p_quest->>'ends_at')::timestamptz, reward = p_quest->'reward',
        max_approvals = (p_quest->>'max_approvals')::integer,
        min_account_level = COALESCE((p_quest->>'min_account_level')::integer, 1), updated_at = now()
      WHERE id = p_id;
      v_id := p_id;
    END IF;
  EXCEPTION WHEN check_violation OR not_null_violation OR invalid_datetime_format OR invalid_text_representation
    OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'invalid_partner_quest' USING ERRCODE = '22023';
  END;
  RETURN jsonb_build_object('id', v_id);
END
$function$;

CREATE OR REPLACE FUNCTION admin.partner_quest_set_status(p_actor uuid, p_id bigint, p_status text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE v_current text;
BEGIN
  PERFORM admin.partner_quest_founder(p_actor);
  SELECT status INTO v_current FROM public.partner_quests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'partner_quest_unknown' USING ERRCODE = '22023'; END IF;
  IF p_status NOT IN ('active', 'paused', 'ended') OR v_current = 'ended' THEN
    RAISE EXCEPTION 'partner_quest_status_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE public.partner_quests SET status = p_status, updated_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'status', p_status);
END
$function$;

-- Approve or reject one pending submission. Approval takes one budget slot.
CREATE OR REPLACE FUNCTION admin.partner_quest_review(p_actor uuid, p_submission bigint, p_decision text, p_note text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE
  v_submission public.partner_quest_submissions%ROWTYPE;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM admin.partner_quest_founder(p_actor);
  IF p_decision NOT IN ('approve', 'reject') OR char_length(COALESCE(v_note, '')) > 300
    OR (p_decision = 'reject' AND v_note IS NULL) THEN
    RAISE EXCEPTION 'invalid_partner_review' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_submission FROM public.partner_quest_submissions WHERE id = p_submission FOR UPDATE;
  IF NOT FOUND OR v_submission.status <> 'pending' THEN RAISE EXCEPTION 'partner_submission_not_pending' USING ERRCODE = '22023'; END IF;
  IF p_decision = 'approve' THEN
    UPDATE public.partner_quests SET approvals_count = approvals_count + 1, updated_at = now()
    WHERE id = v_submission.quest_id AND approvals_count < max_approvals;
    IF NOT FOUND THEN RAISE EXCEPTION 'partner_quest_budget_exhausted' USING ERRCODE = '22023'; END IF;
  END IF;
  UPDATE public.partner_quest_submissions SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
    reviewed_at = now(), reviewer_kind = 'founder', reviewer_id = p_actor, review_note = v_note
  WHERE id = p_submission;
  INSERT INTO public.partner_quest_events(submission_id, kind, actor_kind, actor_id, detail)
  VALUES (p_submission, CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END, 'founder', p_actor,
    jsonb_strip_nulls(jsonb_build_object('note', v_note, 'agent_verdict', v_submission.agent_verdict)));
  RETURN jsonb_build_object('id', p_submission, 'status', CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END);
END
$function$;

-- Agent pre-check: a recommendation only, never an approval. Run by the
-- operator-side agent runner, not granted to the panel role.
CREATE OR REPLACE FUNCTION admin.partner_quest_agent_record(p_submission bigint, p_verdict text, p_note text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
BEGIN
  IF p_verdict NOT IN ('looks_ok', 'suspicious', 'unverifiable') OR char_length(COALESCE(p_note, '')) > 300 THEN
    RAISE EXCEPTION 'invalid_agent_verdict' USING ERRCODE = '22023';
  END IF;
  UPDATE public.partner_quest_submissions SET agent_verdict = p_verdict, agent_note = NULLIF(btrim(COALESCE(p_note, '')), ''), agent_at = now()
  WHERE id = p_submission AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'partner_submission_not_pending' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.partner_quest_events(submission_id, kind, actor_kind, detail)
  VALUES (p_submission, 'agent_checked', 'agent', jsonb_strip_nulls(jsonb_build_object('verdict', p_verdict, 'note', p_note)));
  RETURN jsonb_build_object('id', p_submission, 'agent_verdict', p_verdict);
END
$function$;

-- Panel read: quests with counts, and the review queue with abuse signals.
CREATE OR REPLACE FUNCTION admin.partner_quest_overview(p_status text DEFAULT 'pending', p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
  SELECT jsonb_build_object(
    'as_of', now(),
    'quests', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', q.id, 'kind', q.kind, 'title', q.title, 'body', q.body, 'partner', q.partner, 'target_url', q.target_url,
      'starts_at', q.starts_at, 'ends_at', q.ends_at, 'reward', q.reward, 'max_approvals', q.max_approvals,
      'approvals_count', q.approvals_count, 'min_account_level', q.min_account_level, 'status', q.status,
      'live', q.status = 'active' AND now() >= q.starts_at AND now() < q.ends_at,
      'counts', (SELECT jsonb_build_object(
        'started', count(*) FILTER (WHERE s.status = 'started'), 'pending', count(*) FILTER (WHERE s.status = 'pending'),
        'approved', count(*) FILTER (WHERE s.status = 'approved'), 'rejected', count(*) FILTER (WHERE s.status = 'rejected'),
        'claimed', count(*) FILTER (WHERE s.status = 'claimed'))
        FROM public.partner_quest_submissions s WHERE s.quest_id = q.id)
    ) ORDER BY q.created_at DESC, q.id DESC) FROM public.partner_quests q), '[]'::jsonb),
    'submissions', coalesce((SELECT jsonb_agg(item ORDER BY submitted_at NULLS LAST, id) FROM (
      SELECT s.id, s.submitted_at, jsonb_build_object(
        'id', s.id, 'quest_id', s.quest_id, 'quest_title', q.title, 'kind', q.kind, 'target_url', q.target_url,
        'player_id', s.player_id, 'account_level', p.account_level,
        'social_handle', s.social_handle, 'proof', s.proof, 'status', s.status,
        'started_at', s.started_at, 'submitted_at', s.submitted_at, 'seconds_to_submit',
          floor(extract(epoch FROM (s.submitted_at - s.started_at)))::bigint,
        'resubmits', s.resubmits, 'review_note', s.review_note, 'reviewed_at', s.reviewed_at,
        'agent_verdict', s.agent_verdict, 'agent_note', s.agent_note,
        'handle_changes', (SELECT count(*) FROM public.player_social_link_events e WHERE e.player_id = s.player_id AND e.kind = 'changed'),
        'player_approved_total', (SELECT count(*) FROM public.partner_quest_submissions o WHERE o.player_id = s.player_id AND o.status IN ('approved', 'claimed')),
        'events', (SELECT jsonb_agg(jsonb_build_object('kind', e.kind, 'actor', e.actor_kind, 'at', e.created_at, 'detail', e.detail) ORDER BY e.id)
          FROM public.partner_quest_events e WHERE e.submission_id = s.id)
      ) AS item
      FROM public.partner_quest_submissions s
      JOIN public.partner_quests q ON q.id = s.quest_id
      LEFT JOIN public.players p ON p.player_id = s.player_id
      WHERE s.status = COALESCE(NULLIF(p_status, 'all'), s.status) AND s.status <> 'started'
      ORDER BY s.submitted_at DESC NULLS LAST, s.id DESC
      LIMIT least(greatest(coalesce(p_limit, 200), 1), 500)) recent), '[]'::jsonb)
  );
$function$;

DO $audit_kinds$
DECLARE
  v_constraint text;
  v_kinds text[];
BEGIN
  SELECT conname, ARRAY(SELECT m[1] FROM regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''', 'g') m)
  INTO v_constraint, v_kinds
  FROM pg_constraint
  WHERE conrelid = 'admin.audit_log'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%event_kind%';
  IF v_constraint IS NULL OR cardinality(v_kinds) < 5 THEN RAISE EXCEPTION 'audit_kind_constraint_missing'; END IF;
  IF NOT 'partner_quest' = ANY(v_kinds) THEN v_kinds := array_append(v_kinds, 'partner_quest'); END IF;
  EXECUTE format('ALTER TABLE admin.audit_log DROP CONSTRAINT %I', v_constraint);
  EXECUTE format('ALTER TABLE admin.audit_log ADD CONSTRAINT audit_log_event_kind_check CHECK (event_kind = ANY (%L::text[]))', v_kinds);
END
$audit_kinds$;

-- The rate limiter rejects unregistered actions, including reads.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  IF to_regprocedure('heroloop_api.consume_rate_limit(uuid,text)') IS NULL THEN RETURN; END IF;
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''support_ticket_list'',10,60),',
    '(''support_ticket_list'',10,60),(''social_link_set'',5,300),(''partner_quest_list'',20,60),(''partner_quest_start'',20,60),(''partner_quest_submit'',10,300),(''partner_quest_claim'',10,60),');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'partner_quest_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END
$$;

REVOKE ALL ON FUNCTION public.partner_quest_reward_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.partner_quest_provider(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.social_link_set(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.social_link_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.partner_quest_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.partner_quest_start(uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.partner_quest_submit(uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.partner_quest_claim(uuid,uuid,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_save(uuid,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_set_status(uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_review(uuid,bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_agent_record(bigint,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_overview(text,integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION heroloop_api.social_link_set(uuid,text,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.social_link_list(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.partner_quest_list(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.partner_quest_start(uuid,bigint) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.partner_quest_submit(uuid,bigint,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.partner_quest_claim(uuid,uuid,bigint,bigint) TO heroloop_api;
GRANT EXECUTE ON FUNCTION admin.partner_quest_save(uuid,bigint,jsonb) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.partner_quest_set_status(uuid,bigint,text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.partner_quest_review(uuid,bigint,text,text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.partner_quest_overview(text,integer) TO heroloop_admin;
