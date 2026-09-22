CREATE TABLE public.resource_catalog (
  resource_id text PRIMARY KEY CHECK (resource_id ~ '^[a-z][a-z0-9_]{1,63}$'),
  family text NOT NULL CHECK (family IN ('potion', 'key', 'summon', 'chest', 'crafting')),
  display_order smallint NOT NULL UNIQUE CHECK (display_order BETWEEN 1 AND 64),
  enabled boolean NOT NULL DEFAULT true,
  spendable boolean NOT NULL DEFAULT true,
  deletable boolean NOT NULL DEFAULT false,
  maximum_balance bigint NOT NULL CHECK (maximum_balance BETWEEN 1 AND 10000000000000000),
  catalog_version integer NOT NULL DEFAULT 1 CHECK (catalog_version > 0)
);

INSERT INTO public.resource_catalog(resource_id, family, display_order, maximum_balance) VALUES
  ('potion_xs', 'potion', 1, 1000000000),
  ('potion_sm', 'potion', 2, 1000000000),
  ('potion_md', 'potion', 3, 1000000000),
  ('potion_lg', 'potion', 4, 1000000000),
  ('potion_xl', 'potion', 5, 1000000000),
  ('potion_xxl', 'potion', 6, 1000000000),
  ('boss_key', 'key', 7, 1000000),
  ('summon_scroll', 'summon', 8, 1000000000),
  ('tutorial_chest', 'chest', 9, 1000000000),
  ('iron_scrap', 'crafting', 10, 10000000000000000),
  ('arcane_dust', 'crafting', 11, 10000000000000000),
  ('astral_shard', 'crafting', 12, 10000000000000000),
  ('godforged_core', 'crafting', 13, 10000000000000000);

CREATE TABLE public.player_resource_state (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.player_resource_balances (
  player_id uuid NOT NULL REFERENCES public.player_resource_state(player_id) ON DELETE CASCADE,
  resource_id text NOT NULL REFERENCES public.resource_catalog(resource_id) ON DELETE RESTRICT,
  quantity_bigint bigint NOT NULL DEFAULT 0 CHECK (quantity_bigint >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, resource_id)
);

CREATE TABLE public.resource_transactions (
  transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.player_resource_state(player_id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_-]{1,63}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_revision_before bigint NOT NULL CHECK (resource_revision_before >= 0),
  resource_revision_after bigint NOT NULL CHECK (resource_revision_after > resource_revision_before),
  save_revision_after bigint CHECK (save_revision_after IS NULL OR save_revision_after > 0),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, idempotency_key)
);

CREATE TABLE public.resource_entries (
  entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES public.resource_transactions(transaction_id) ON DELETE CASCADE,
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 64),
  source_key text NOT NULL CHECK (source_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  resource_id text NOT NULL REFERENCES public.resource_catalog(resource_id) ON DELETE RESTRICT,
  delta_bigint bigint NOT NULL CHECK (delta_bigint <> 0),
  balance_after_bigint bigint NOT NULL CHECK (balance_after_bigint >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, sequence)
);

CREATE INDEX resource_transactions_player_created ON public.resource_transactions(player_id, created_at DESC);
CREATE INDEX resource_entries_resource_created ON public.resource_entries(resource_id, created_at DESC);

CREATE TABLE public.resource_migration_quarantine (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  observed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.resource_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_resource_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_resource_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_migration_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.resource_catalog, public.player_resource_state, public.player_resource_balances,
  public.resource_transactions, public.resource_entries, public.resource_migration_quarantine
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.resource_catalog TO service_role;

CREATE OR REPLACE FUNCTION public.resource_snapshot(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN state.player_id IS NULL THEN NULL ELSE jsonb_build_object(
    'revision', state.revision::text,
    'balances', COALESCE((SELECT jsonb_object_agg(balance.resource_id, balance.quantity_bigint::text ORDER BY catalog.display_order)
      FROM public.player_resource_balances balance JOIN public.resource_catalog catalog USING(resource_id)
      WHERE balance.player_id = state.player_id), '{}'::jsonb)
  ) END
  FROM (SELECT p_player_id AS player_id) requested
  LEFT JOIN public.player_resource_state state ON state.player_id = requested.player_id
$$;

CREATE OR REPLACE FUNCTION public.resource_ledger_initialize(p_player_id uuid, p_state jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_boss_keys bigint;
  v_save_boss_keys bigint;
  v_scrolls bigint;
  v_potions jsonb;
  v_opening jsonb;
  v_transaction_id uuid;
  v_revision bigint;
  v_entry record;
BEGIN
  IF jsonb_typeof(p_state) <> 'object' THEN
    INSERT INTO public.resource_migration_quarantine(player_id, reason_code) VALUES (p_player_id, 'state_not_object')
    ON CONFLICT (player_id) DO UPDATE SET reason_code = EXCLUDED.reason_code, observed_at = now();
    RETURN jsonb_build_object('quarantined', true, 'reason', 'state_not_object');
  END IF;
  BEGIN
    SELECT boss_keys INTO STRICT v_player_boss_keys FROM public.players WHERE player_id = p_player_id FOR UPDATE;
    v_save_boss_keys := COALESCE((p_state->>'bossKeys')::bigint, 0);
    v_scrolls := COALESCE((p_state->>'summonScrolls')::bigint, 0);
    v_potions := COALESCE(p_state->'potions', '{}'::jsonb);
    IF jsonb_typeof(v_potions) <> 'object'
      OR v_potions - ARRAY['xs','sm','md','lg','xl','xxl'] <> '{}'::jsonb
      OR v_player_boss_keys <> v_save_boss_keys
      OR v_scrolls < 0 OR v_scrolls > 10000000000000000 THEN
      RAISE EXCEPTION 'invalid_resource_snapshot';
    END IF;
    FOR v_entry IN SELECT value FROM jsonb_each(v_potions) LOOP
      IF jsonb_typeof(v_entry.value) <> 'number'
        OR (v_entry.value #>> '{}') !~ '^[0-9]+$'
        OR (v_entry.value #>> '{}')::numeric > 10000000000000000 THEN
        RAISE EXCEPTION 'invalid_resource_snapshot';
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.resource_migration_quarantine(player_id, reason_code) VALUES (p_player_id, 'snapshot_conflict')
    ON CONFLICT (player_id) DO UPDATE SET reason_code = EXCLUDED.reason_code, observed_at = now();
    RETURN jsonb_build_object('quarantined', true, 'reason', 'snapshot_conflict');
  END;

  INSERT INTO public.player_resource_state(player_id) VALUES (p_player_id)
  ON CONFLICT (player_id) DO NOTHING
  RETURNING revision INTO v_revision;
  IF v_revision IS NULL THEN RETURN public.resource_snapshot(p_player_id); END IF;

  INSERT INTO public.player_resource_balances(player_id, resource_id, quantity_bigint)
  SELECT p_player_id, resource_id, CASE resource_id
    WHEN 'potion_xs' THEN COALESCE((v_potions->>'xs')::bigint, 0)
    WHEN 'potion_sm' THEN COALESCE((v_potions->>'sm')::bigint, 0)
    WHEN 'potion_md' THEN COALESCE((v_potions->>'md')::bigint, 0)
    WHEN 'potion_lg' THEN COALESCE((v_potions->>'lg')::bigint, 0)
    WHEN 'potion_xl' THEN COALESCE((v_potions->>'xl')::bigint, 0)
    WHEN 'potion_xxl' THEN COALESCE((v_potions->>'xxl')::bigint, 0)
    WHEN 'boss_key' THEN v_player_boss_keys
    WHEN 'summon_scroll' THEN v_scrolls
    ELSE 0 END
  FROM public.resource_catalog ORDER BY display_order;

  v_opening := jsonb_build_object(
    'potion_xs', COALESCE((v_potions->>'xs')::bigint, 0)::text,
    'potion_sm', COALESCE((v_potions->>'sm')::bigint, 0)::text,
    'potion_md', COALESCE((v_potions->>'md')::bigint, 0)::text,
    'potion_lg', COALESCE((v_potions->>'lg')::bigint, 0)::text,
    'potion_xl', COALESCE((v_potions->>'xl')::bigint, 0)::text,
    'potion_xxl', COALESCE((v_potions->>'xxl')::bigint, 0)::text,
    'boss_key', v_player_boss_keys::text,
    'summon_scroll', v_scrolls::text
  );
  v_transaction_id := (substr(md5(p_player_id::text || ':resource-ledger-opening-balance-v1'),1,8) || '-' ||
    substr(md5(p_player_id::text || ':resource-ledger-opening-balance-v1'),9,4) || '-4' ||
    substr(md5(p_player_id::text || ':resource-ledger-opening-balance-v1'),14,3) || '-8' ||
    substr(md5(p_player_id::text || ':resource-ledger-opening-balance-v1'),18,3) || '-' ||
    substr(md5(p_player_id::text || ':resource-ledger-opening-balance-v1'),21,12))::uuid;
  INSERT INTO public.resource_transactions(transaction_id, player_id, idempotency_key, action, request_hash,
    resource_revision_before, resource_revision_after, result)
  VALUES (v_transaction_id, p_player_id, v_transaction_id, 'opening_balance',
    encode(extensions.digest(v_opening::text, 'sha256'), 'hex'), 0, 1,
    jsonb_build_object('applied', true, 'replayed', false, 'revision', '1', 'balances', v_opening));
  INSERT INTO public.resource_entries(transaction_id, sequence, source_key, resource_id, delta_bigint, balance_after_bigint)
  SELECT v_transaction_id, row_number() OVER (ORDER BY catalog.display_order), 'resource_opening_balance',
    balance.resource_id, balance.quantity_bigint, balance.quantity_bigint
  FROM public.player_resource_balances balance JOIN public.resource_catalog catalog USING(resource_id)
  WHERE balance.player_id = p_player_id AND balance.quantity_bigint > 0;
  RETURN public.resource_snapshot(p_player_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_resource_entries(
  p_player_id uuid, p_idempotency_key uuid, p_action text, p_request_hash text,
  p_entries jsonb, p_save_revision_after bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state public.player_resource_state%ROWTYPE;
  v_existing public.resource_transactions%ROWTYPE;
  v_transaction_id uuid := gen_random_uuid();
  v_entry record;
  v_balance bigint;
  v_maximum bigint;
  v_result jsonb;
  v_count integer;
BEGIN
  IF p_action !~ '^[a-z][a-z0-9_-]{1,63}$' OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_resource_request';
  END IF;
  SELECT * INTO v_state FROM public.player_resource_state WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'resource_state_unavailable'; END IF;
  SELECT * INTO v_existing FROM public.resource_transactions
  WHERE player_id = p_player_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash = p_request_hash AND v_existing.action = p_action THEN
      RETURN v_existing.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'resource_idempotency_conflict';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_entries) entry
  WHERE jsonb_typeof(entry) = 'object' AND entry - ARRAY['resource_id','delta','source_key'] = '{}'::jsonb
    AND entry->>'resource_id' ~ '^[a-z][a-z0-9_]{1,63}$'
    AND entry->>'delta' ~ '^-?[0-9]+$' AND (entry->>'delta')::numeric BETWEEN -10000000000000000 AND 10000000000000000
    AND (entry->>'delta')::numeric <> 0
    AND entry->>'source_key' = ANY(ARRAY['tutorial_chest','tutorial_potion','tutorial_chest_open','starter_potion','potion_purchase','potion_use','promo_boss_key','tutorial_boss_key','boss_key_spend','summon_milestone_scroll','tutorial_summon_scroll','boss_summon_scroll','promo_summon_scroll','free_summon_scroll','resource_opening_balance','item_salvage_material','item_craft_material']);
  IF v_count <> jsonb_array_length(p_entries) THEN RAISE EXCEPTION 'invalid_resource_entries'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_entries) entry
    LEFT JOIN public.resource_catalog catalog ON catalog.resource_id = entry->>'resource_id'
    WHERE catalog.resource_id IS NULL OR NOT catalog.enabled
      OR ((entry->>'delta')::numeric < 0 AND NOT catalog.spendable)
  ) THEN RAISE EXCEPTION 'resource_unavailable'; END IF;
  PERFORM balance.resource_id FROM public.player_resource_balances balance
  WHERE balance.player_id = p_player_id AND balance.resource_id IN
    (SELECT entry->>'resource_id' FROM jsonb_array_elements(p_entries) entry)
  ORDER BY balance.resource_id FOR UPDATE;
  IF (SELECT count(DISTINCT entry->>'resource_id') FROM jsonb_array_elements(p_entries) entry) <>
    (SELECT count(*) FROM public.player_resource_balances balance WHERE balance.player_id = p_player_id AND balance.resource_id IN
      (SELECT entry->>'resource_id' FROM jsonb_array_elements(p_entries) entry)) THEN
    RAISE EXCEPTION 'unknown_resource';
  END IF;
  INSERT INTO public.resource_transactions(transaction_id, player_id, idempotency_key, action, request_hash,
    resource_revision_before, resource_revision_after, save_revision_after, result)
  VALUES (v_transaction_id, p_player_id, p_idempotency_key, p_action, p_request_hash,
    v_state.revision, v_state.revision + 1, p_save_revision_after, '{}'::jsonb);
  FOR v_entry IN SELECT value, ordinality FROM jsonb_array_elements(p_entries) WITH ORDINALITY LOOP
    SELECT balance.quantity_bigint, catalog.maximum_balance INTO v_balance, v_maximum
    FROM public.player_resource_balances balance JOIN public.resource_catalog catalog USING(resource_id)
    WHERE balance.player_id = p_player_id AND balance.resource_id = v_entry.value->>'resource_id';
    v_balance := v_balance + (v_entry.value->>'delta')::bigint;
    IF v_balance < 0 THEN RAISE EXCEPTION 'resource_insufficient_balance'; END IF;
    IF v_balance > v_maximum THEN RAISE EXCEPTION 'resource_balance_cap'; END IF;
    UPDATE public.player_resource_balances SET quantity_bigint = v_balance, updated_at = now()
    WHERE player_id = p_player_id AND resource_id = v_entry.value->>'resource_id';
    INSERT INTO public.resource_entries(transaction_id, sequence, source_key, resource_id, delta_bigint, balance_after_bigint)
    VALUES (v_transaction_id, v_entry.ordinality, v_entry.value->>'source_key', v_entry.value->>'resource_id',
      (v_entry.value->>'delta')::bigint, v_balance);
  END LOOP;
  UPDATE public.player_resource_state SET revision = revision + 1, updated_at = now()
  WHERE player_id = p_player_id RETURNING * INTO v_state;
  v_result := public.resource_snapshot(p_player_id) || jsonb_build_object('applied', true, 'replayed', false);
  UPDATE public.resource_transactions SET result = v_result WHERE transaction_id = v_transaction_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.resource_ledger_player_save_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.resource_ledger_initialize(NEW.player_id, NEW.state);
  RETURN NEW;
END;
$$;
CREATE TRIGGER player_save_resource_ledger_initialize
AFTER INSERT ON public.player_saves FOR EACH ROW EXECUTE FUNCTION public.resource_ledger_player_save_trigger();

DO $$ DECLARE v_save record; BEGIN
  FOR v_save IN SELECT player_id, state FROM public.player_saves ORDER BY player_id LOOP
    PERFORM public.resource_ledger_initialize(v_save.player_id, v_save.state);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.resource_ledger_reconciliation()
RETURNS TABLE(player_id uuid, issue_code text, resource_id text, expected_quantity text, actual_quantity text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH entry_totals AS (
    SELECT transaction.player_id, entry.resource_id, sum(entry.delta_bigint)::bigint AS quantity
    FROM public.resource_transactions transaction JOIN public.resource_entries entry USING(transaction_id)
    GROUP BY transaction.player_id, entry.resource_id
  ), drift AS (
    SELECT balance.player_id, 'snapshot_ledger_drift'::text issue_code, balance.resource_id,
      COALESCE(total.quantity, 0)::text expected_quantity, balance.quantity_bigint::text actual_quantity
    FROM public.player_resource_balances balance
    LEFT JOIN entry_totals total USING(player_id, resource_id)
    WHERE balance.quantity_bigint <> COALESCE(total.quantity, 0)
  ), openings AS (
    SELECT state.player_id, 'opening_transaction_count'::text issue_code, NULL::text resource_id,
      '1'::text expected_quantity, count(transaction.transaction_id)::text actual_quantity
    FROM public.player_resource_state state LEFT JOIN public.resource_transactions transaction
      ON transaction.player_id = state.player_id AND transaction.action = 'opening_balance'
    GROUP BY state.player_id HAVING count(transaction.transaction_id) <> 1
  ), invalid_sources AS (
    SELECT transaction.player_id, 'unknown_source_key'::text issue_code, entry.resource_id,
      NULL::text expected_quantity, entry.source_key actual_quantity
    FROM public.resource_entries entry JOIN public.resource_transactions transaction USING(transaction_id)
    WHERE entry.source_key <> ALL(ARRAY['tutorial_chest','tutorial_potion','tutorial_chest_open','starter_potion','potion_purchase','potion_use','promo_boss_key','tutorial_boss_key','boss_key_spend','summon_milestone_scroll','tutorial_summon_scroll','boss_summon_scroll','promo_summon_scroll','free_summon_scroll','resource_opening_balance','item_salvage_material','item_craft_material'])
  )
  SELECT * FROM drift UNION ALL SELECT * FROM openings UNION ALL SELECT * FROM invalid_sources
$$;

REVOKE ALL ON FUNCTION public.resource_ledger_initialize(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resource_ledger_player_save_trigger() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_resource_entries(uuid, uuid, text, text, jsonb, bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resource_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resource_snapshot(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.resource_ledger_reconciliation() FROM PUBLIC, anon, authenticated, service_role;
