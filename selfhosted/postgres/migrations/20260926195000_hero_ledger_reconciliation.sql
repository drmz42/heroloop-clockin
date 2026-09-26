\set ON_ERROR_STOP on

-- $HERO ledger reconciliation reporter
-- (config/economy/hero-ledger-reconciliation.v1.json, docs/game/progression-and-economy.md).
--
-- The global equation, with every term read in one statement so they describe
-- the same instant:
--
--   player total now = baseline player total
--                    + player_issuance since the baseline
--                    - treasury_inflow since the baseline
--                    - balance_extinguishment since the baseline
--
-- "Since the baseline" is the difference between per-flow ledger totals now and
-- the totals recorded with the baseline, not "rows with a higher id": an
-- identity is handed out at insert, not at commit, so an id watermark can skip a
-- row that commits late. Totals taken in the same snapshot as the player sum
-- cannot.
--
-- The Founder takes the baseline (admin.hero_ledger_take_baseline, from the
-- Control Center with a reason). Until one exists a run reports no_baseline and
-- alerts nothing. A run also counts coverage gaps: settled source events with no
-- ledger row, ledger rows whose still-existing source differs in amount or is
-- missing, unknown source kinds and negative balances. Drift tolerance is zero.
-- A failing run raises one critical notification, a run that passes after a
-- failing one raises a recovery notice, and nothing is ever repaired: this is a
-- report. Player ids never leave the database; every figure is a total or a
-- count.

CREATE TABLE IF NOT EXISTS admin.hero_ledger_baselines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at timestamptz NOT NULL DEFAULT now(),
  actor_identity_id uuid REFERENCES admin.identities(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  player_total numeric NOT NULL,
  issuance_total numeric NOT NULL,
  inflow_total numeric NOT NULL,
  extinguishment_total numeric NOT NULL,
  ledger_rows bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS admin.hero_ledger_reconciliation_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  baseline_id bigint REFERENCES admin.hero_ledger_baselines(id),
  status text NOT NULL CHECK (status IN ('balanced', 'failing', 'no_baseline')),
  result jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS hero_ledger_reconciliation_runs_time ON admin.hero_ledger_reconciliation_runs(ran_at DESC);

CREATE OR REPLACE RULE hero_ledger_baselines_no_update AS ON UPDATE TO admin.hero_ledger_baselines DO INSTEAD NOTHING;
CREATE OR REPLACE RULE hero_ledger_baselines_no_delete AS ON DELETE TO admin.hero_ledger_baselines DO INSTEAD NOTHING;
CREATE OR REPLACE RULE hero_ledger_reconciliation_runs_no_update AS ON UPDATE TO admin.hero_ledger_reconciliation_runs DO INSTEAD NOTHING;
CREATE OR REPLACE RULE hero_ledger_reconciliation_runs_no_delete AS ON DELETE TO admin.hero_ledger_reconciliation_runs DO INSTEAD NOTHING;

COMMENT ON TABLE admin.hero_ledger_baselines IS
  'Append-only $HERO reconciliation baselines: the player total and per-flow ledger totals read in one snapshot, who took it and why.';
COMMENT ON TABLE admin.hero_ledger_reconciliation_runs IS
  'Append-only $HERO reconciliation results: status, expected and actual player total, drift and coverage gap counts; totals only, never a player.';

-- Every kind the ledger may carry: the contract's live and legacy kinds plus
-- the two coverage kinds added on 2026-09-26. Anything else is unknown.
CREATE OR REPLACE FUNCTION admin.hero_ledger_known_kinds()
RETURNS text[] LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT ARRAY[
    'mining_pool', 'promo_code', 'quest-reward', 'tester_credit',
    'hero-summon', 'hero-ascension', 'training-slot',
    'training-boost-2x-1h', 'training-boost-2x-4h', 'training-boost-4x-1h', 'training-boost-4x-4h',
    'item-enchant', 'enchant-charm', 'item-reroll',
    'reward-boost-24h', 'reward-boost-7d', 'reward-boost-30d', 'market_fee',
    'trainingboost2x1h', 'account_balance_extinguishment'
  ]::text[]
$function$;

-- The four figures of the equation, in one statement.
CREATE OR REPLACE FUNCTION admin.hero_ledger_totals()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'player_total', (SELECT coalesce(sum(coalesce(token_balance, 0) + coalesce(pending_tokens, 0)), 0) FROM public.players),
    'issuance_total', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance'),
    'inflow_total', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'treasury_inflow'),
    'extinguishment_total', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'balance_extinguishment'),
    'ledger_rows', (SELECT count(*) FROM public.hero_economy_ledger)
  )
$function$;

CREATE OR REPLACE FUNCTION admin.hero_ledger_take_baseline(p_actor uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_totals jsonb;
  v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND status = 'active' AND role = 'founder') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  -- One statement, so one snapshot, for the player sum and the ledger totals:
  -- no settlement can land between them.
  v_totals := admin.hero_ledger_totals();
  INSERT INTO admin.hero_ledger_baselines(actor_identity_id, reason, player_total, issuance_total, inflow_total, extinguishment_total, ledger_rows)
  VALUES (p_actor, btrim(p_reason), (v_totals->>'player_total')::numeric, (v_totals->>'issuance_total')::numeric,
          (v_totals->>'inflow_total')::numeric, (v_totals->>'extinguishment_total')::numeric, (v_totals->>'ledger_rows')::bigint)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('baseline_id', v_id) || v_totals;
END
$function$;

-- Coverage: every settled source event must have its ledger row with the same
-- amount. A source event can vanish with its account (the source tables cascade
-- on player deletion while the ledger keeps its row with a null player), so a
-- ledger row without a source only counts while its account still exists.
CREATE OR REPLACE FUNCTION admin.hero_ledger_coverage()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sources jsonb := '{}'::jsonb;
  v_missing bigint;
  v_mismatch bigint;
  v_orphan bigint;
BEGIN
  IF to_regclass('public.token_spend_events') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> e.amount)
      INTO v_missing, v_mismatch
    FROM public.token_spend_events e
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'token_spend:' || e.idempotency_key
    WHERE e.amount > 0;
    SELECT count(*) INTO v_orphan FROM public.hero_economy_ledger l
    WHERE l.source_key LIKE 'token_spend:%' AND l.player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.token_spend_events e WHERE 'token_spend:' || e.idempotency_key = l.source_key);
    v_sources := v_sources || jsonb_build_object('token_spend', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch, 'missing_source', v_orphan));
  END IF;

  IF to_regclass('public.distribution_log') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> d.amount_distributed)
      INTO v_missing, v_mismatch
    FROM public.distribution_log d
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'distribution:' || d.id
    WHERE d.amount_distributed > 0;
    SELECT count(*) INTO v_orphan FROM public.hero_economy_ledger l
    WHERE l.source_key LIKE 'distribution:%'
      AND NOT EXISTS (SELECT 1 FROM public.distribution_log d WHERE 'distribution:' || d.id = l.source_key);
    v_sources := v_sources || jsonb_build_object('distribution', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch, 'missing_source', v_orphan));
  END IF;

  IF to_regclass('public.market_item_events') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> (e.result->>'fee')::numeric)
      INTO v_missing, v_mismatch
    FROM public.market_item_events e
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'market_fee:' || e.idempotency_key
    WHERE e.action = 'buy' AND coalesce(e.result->>'fee', '') ~ '^[0-9]+([.][0-9]+)?$' AND (e.result->>'fee')::numeric > 0;
    v_sources := v_sources || jsonb_build_object('market_fee', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch));
  END IF;

  IF to_regclass('public.promo_code_redemptions') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE l.id IS NULL), count(*) FILTER (WHERE l.id IS NOT NULL AND l.amount <> (e.result#>>'{rewards,hero}')::numeric)
      INTO v_missing, v_mismatch
    FROM public.promo_code_redemptions e
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'promo:' || e.idempotency_key
    WHERE coalesce(e.result#>>'{rewards,hero}', '') ~ '^[0-9]+([.][0-9]+)?$' AND (e.result#>>'{rewards,hero}')::numeric > 0;
    v_sources := v_sources || jsonb_build_object('promo', jsonb_build_object('missing_ledger', v_missing, 'amount_mismatch', v_mismatch));
  END IF;

  RETURN jsonb_build_object(
    'sources', v_sources,
    'unknown_source_kinds', (SELECT count(DISTINCT source_kind) FROM public.hero_economy_ledger WHERE NOT (source_kind = ANY (admin.hero_ledger_known_kinds()))),
    'negative_balances', (SELECT count(*) FROM public.players WHERE coalesce(token_balance, 0) < 0 OR coalesce(pending_tokens, 0) < 0),
    -- source_key is UNIQUE, so this stays zero unless the constraint is lost.
    'duplicate_keys', (SELECT count(*) FROM (SELECT source_key FROM public.hero_economy_ledger GROUP BY source_key HAVING count(*) > 1) d),
    'not_checked', jsonb_build_array('quest-reward', 'tester_credit', 'account_balance_extinguishment')
  );
END
$function$;

CREATE OR REPLACE FUNCTION admin.hero_ledger_reconcile()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_baseline admin.hero_ledger_baselines%ROWTYPE;
  v_totals jsonb;
  v_coverage jsonb;
  v_expected numeric;
  v_actual numeric;
  v_drift numeric;
  v_gaps bigint;
  v_status text;
  v_previous text;
  v_result jsonb;
BEGIN
  SELECT * INTO v_baseline FROM admin.hero_ledger_baselines ORDER BY taken_at DESC, id DESC LIMIT 1;
  v_totals := admin.hero_ledger_totals();
  v_coverage := admin.hero_ledger_coverage();

  SELECT coalesce(sum(c.n::numeric), 0) INTO v_gaps
  FROM jsonb_each(v_coverage->'sources') AS s(source, counts), jsonb_each_text(s.counts) AS c(field, n);
  v_gaps := v_gaps + (v_coverage->>'unknown_source_kinds')::bigint + (v_coverage->>'negative_balances')::bigint
          + (v_coverage->>'duplicate_keys')::bigint;

  v_actual := (v_totals->>'player_total')::numeric;
  IF v_baseline.id IS NULL THEN
    v_status := 'no_baseline';
  ELSE
    v_expected := v_baseline.player_total
      + ((v_totals->>'issuance_total')::numeric - v_baseline.issuance_total)
      - ((v_totals->>'inflow_total')::numeric - v_baseline.inflow_total)
      - ((v_totals->>'extinguishment_total')::numeric - v_baseline.extinguishment_total);
    v_drift := v_actual - v_expected;
    v_status := CASE WHEN v_drift = 0 AND v_gaps = 0 THEN 'balanced' ELSE 'failing' END;
  END IF;

  v_result := jsonb_build_object(
    'baseline_id', v_baseline.id,
    'baseline_taken_at', v_baseline.taken_at,
    'expected_player_total', v_expected,
    'actual_player_total', v_actual,
    'drift', v_drift,
    'issuance_since_baseline', (v_totals->>'issuance_total')::numeric - v_baseline.issuance_total,
    'inflow_since_baseline', (v_totals->>'inflow_total')::numeric - v_baseline.inflow_total,
    'extinguishment_since_baseline', (v_totals->>'extinguishment_total')::numeric - v_baseline.extinguishment_total,
    'gap_count', v_gaps,
    'coverage', v_coverage
  );

  SELECT status INTO v_previous FROM admin.hero_ledger_reconciliation_runs ORDER BY ran_at DESC, id DESC LIMIT 1;
  INSERT INTO admin.hero_ledger_reconciliation_runs(baseline_id, status, result) VALUES (v_baseline.id, v_status, v_result);

  -- State changes only: the first failing run alerts, and a passing run after a
  -- failing one says so. Counts and totals only.
  IF v_status = 'failing' AND v_previous IS DISTINCT FROM 'failing' THEN
    PERFORM admin.notification_record('economy_anomalies', 'critical', 'economy:ledger_reconciliation',
      '$HERO reconciliation failed',
      format('Difference %s $HERO, coverage gaps %s. Nothing was corrected; details under Economy.', coalesce(v_drift, 0), v_gaps),
      24);
  ELSIF v_status = 'balanced' AND v_previous = 'failing' THEN
    PERFORM admin.notification_record('economy_anomalies', 'info', 'economy:ledger_reconciliation_recovered',
      '$HERO reconciliation matches again',
      'The last reconciliation run finished with no difference and no gaps.',
      24);
  END IF;

  RETURN jsonb_build_object('status', v_status, 'ran_at', now()) || v_result;
END
$function$;

-- Daily source totals by Moscow day, for the screen and the CSV. Aggregates
-- only: day, flow, kind, balance version, count and amount.
CREATE OR REPLACE FUNCTION admin.hero_ledger_daily(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'timezone', 'Europe/Moscow',
    'days', least(greatest(coalesce(p_days, 30), 1), 366),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'moscow_day', day, 'balance_version', balance_version, 'flow', flow, 'source_kind', source_kind,
      'event_count', n, 'amount', amount
    ) ORDER BY day DESC, flow, source_kind, balance_version), '[]'::jsonb)
  )
  FROM (
    SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS day,
           coalesce(economy_balance_version, 'unversioned') AS balance_version,
           flow, source_kind, count(*) AS n, sum(amount) AS amount
    FROM public.hero_economy_ledger
    WHERE occurred_at >= ((now() AT TIME ZONE 'Europe/Moscow')::date - least(greatest(coalesce(p_days, 30), 1), 366) + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
    GROUP BY 1, 2, 3, 4
  ) d
$function$;

CREATE OR REPLACE FUNCTION admin.hero_ledger_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'latest_run', (SELECT jsonb_build_object('id', id, 'ran_at', ran_at, 'status', status, 'result', result)
                   FROM admin.hero_ledger_reconciliation_runs ORDER BY ran_at DESC, id DESC LIMIT 1),
    'baseline', (SELECT jsonb_build_object('id', id, 'taken_at', taken_at, 'reason', reason, 'player_total', player_total, 'ledger_rows', ledger_rows)
                 FROM admin.hero_ledger_baselines ORDER BY taken_at DESC, id DESC LIMIT 1),
    'runs_7d', (SELECT coalesce(jsonb_agg(jsonb_build_object('ran_at', ran_at, 'status', status, 'drift', result->'drift', 'gap_count', result->'gap_count') ORDER BY ran_at DESC), '[]'::jsonb)
                FROM admin.hero_ledger_reconciliation_runs WHERE ran_at >= now() - interval '7 days'),
    'stale_after_hours', 26
  )
$function$;

DO $audit_kinds$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname INTO v_constraint FROM pg_constraint
  WHERE conrelid = 'admin.audit_log'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_kind%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE admin.audit_log DROP CONSTRAINT %I', v_constraint);
  END IF;
  ALTER TABLE admin.audit_log ADD CONSTRAINT audit_log_event_kind_check CHECK (event_kind IN (
    'login_identity', 'login_passkey', 'passkey_enroll', 'step_up', 'view_access', 'allowlist_change',
    'player_search', 'player_view', 'player_unmask', 'support_note', 'player_operation',
    'analytics_export', 'account_deletion', 'notification_acknowledge', 'todo_action', 'feature_flag_change',
    'simulation_run', 'incident_record', 'support_ticket', 'finance_record', 'privacy_request', 'ledger_baseline'
  ));
END
$audit_kinds$;

REVOKE ALL ON admin.hero_ledger_baselines FROM PUBLIC;
REVOKE ALL ON admin.hero_ledger_reconciliation_runs FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_known_kinds() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_coverage() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_take_baseline(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_reconcile() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_daily(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.hero_ledger_status() FROM PUBLIC;
-- The panel reads status and daily totals and takes a baseline as the founder;
-- it cannot run the reconciliation itself, which is the daily timer's job.
GRANT EXECUTE ON FUNCTION admin.hero_ledger_take_baseline(uuid, text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.hero_ledger_daily(integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.hero_ledger_status() TO heroloop_admin;
