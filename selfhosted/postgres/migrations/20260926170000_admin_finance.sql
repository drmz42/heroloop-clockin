\set ON_ERROR_STOP on

-- Project finance ledger for the Founder Control Center
-- (docs/game/founder-control-center-v2-tz.md, "Finance").
--
-- Costs (servers, AI, subscriptions, domains, marketing) and income (Shop,
-- token) in one place, written by the Founder from invoices and statements.
-- Nothing reads a bank, a card or a wallet: the game has no real-money payment
-- path yet, so automatic Shop and token income is reported not_connected
-- rather than as zero.
--
-- Money is recorded, never moved. A row is never edited or deleted: a mistake
-- is undone by one reversal row carrying the negative amount, so every total is
-- a plain sum and the history of what was believed when stays readable. The
-- panel role can only read the table and write through the two founder-checked
-- functions below.

CREATE TABLE IF NOT EXISTS admin.finance_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL REFERENCES admin.identities(id),
  direction text NOT NULL CHECK (direction IN ('expense', 'income')),
  category text NOT NULL,
  period_month date NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USD', 'EUR', 'RUB')),
  label text NOT NULL,
  reverses_id bigint UNIQUE REFERENCES admin.finance_entries(id),
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT finance_entries_category CHECK (
    (direction = 'expense' AND category IN ('servers', 'ai', 'subscriptions', 'domains', 'marketing', 'other'))
    OR (direction = 'income' AND category IN ('shop', 'token', 'other'))
  ),
  CONSTRAINT finance_entries_month_start CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT finance_entries_amount_sign CHECK (
    (reverses_id IS NULL AND amount_minor BETWEEN 1 AND 10000000000)
    OR (reverses_id IS NOT NULL AND amount_minor BETWEEN -10000000000 AND -1)
  ),
  CONSTRAINT finance_entries_label_length CHECK (char_length(label) BETWEEN 3 AND 120),
  CONSTRAINT finance_entries_label_carries_no_contact CHECK (position('@' IN label) = 0),
  CONSTRAINT finance_entries_label_carries_no_identifier CHECK (label !~ '[A-Za-z0-9]{26}')
);
CREATE INDEX IF NOT EXISTS finance_entries_month_idx ON admin.finance_entries(period_month DESC, id DESC);

COMMENT ON TABLE admin.finance_entries IS
  'Founder Control Center finance ledger: costs and income the Founder records from invoices; append-only, a mistake is undone by one negative reversal row.';

-- Refusals are raised as plain codes the BFF maps to HTTP statuses.
CREATE OR REPLACE FUNCTION admin.finance_require_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND role = 'founder' AND status = 'active') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION admin.finance_check_label(p_label text)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_label text := btrim(coalesce(p_label, ''));
BEGIN
  IF char_length(v_label) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'invalid_finance_label' USING ERRCODE = '22023';
  END IF;
  IF position('@' IN v_label) > 0 OR v_label ~ '[A-Za-z0-9]{26}' THEN
    RAISE EXCEPTION 'finance_label_carries_identifier' USING ERRCODE = '22023';
  END IF;
  RETURN v_label;
END
$function$;

-- Records one cost or income for one month. A retry with the same key returns
-- the row it already wrote; the same key with other content is refused.
CREATE OR REPLACE FUNCTION admin.finance_record(
  p_actor uuid, p_direction text, p_category text, p_period_month date,
  p_amount_minor bigint, p_currency text, p_label text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_existing admin.finance_entries%ROWTYPE;
  v_label text;
  v_id bigint;
BEGIN
  PERFORM admin.finance_require_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('expense', 'income') THEN
    RAISE EXCEPTION 'invalid_finance_direction' USING ERRCODE = '22023';
  END IF;
  IF p_category IS NULL
    OR (p_direction = 'expense' AND p_category NOT IN ('servers', 'ai', 'subscriptions', 'domains', 'marketing', 'other'))
    OR (p_direction = 'income' AND p_category NOT IN ('shop', 'token', 'other')) THEN
    RAISE EXCEPTION 'invalid_finance_category' USING ERRCODE = '22023';
  END IF;
  -- From the start of 2025 to twelve months ahead: a prepaid year is fine, a
  -- typo in the year is not.
  IF p_period_month IS NULL OR p_period_month <> date_trunc('month', p_period_month)::date
    OR p_period_month < DATE '2025-01-01'
    OR p_period_month > (date_trunc('month', now()) + interval '12 months')::date THEN
    RAISE EXCEPTION 'invalid_finance_month' USING ERRCODE = '22023';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor NOT BETWEEN 1 AND 10000000000 THEN
    RAISE EXCEPTION 'invalid_finance_amount' USING ERRCODE = '22023';
  END IF;
  IF p_currency IS NULL OR p_currency NOT IN ('USD', 'EUR', 'RUB') THEN
    RAISE EXCEPTION 'invalid_finance_currency' USING ERRCODE = '22023';
  END IF;
  v_label := admin.finance_check_label(p_label);

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.finance'));
  SELECT * INTO v_existing FROM admin.finance_entries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.reverses_id IS NOT NULL OR v_existing.direction <> p_direction OR v_existing.category <> p_category
      OR v_existing.period_month <> p_period_month OR v_existing.amount_minor <> p_amount_minor
      OR v_existing.currency <> p_currency OR v_existing.label <> v_label THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;

  INSERT INTO admin.finance_entries(recorded_by, direction, category, period_month, amount_minor, currency, label, idempotency_key)
  VALUES (p_actor, p_direction, p_category, p_period_month, p_amount_minor, p_currency, v_label, p_idempotency_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

-- Undoes one entry with a single negative row in the same month, category and
-- currency. A reversal cannot itself be reversed and an entry is reversed at
-- most once; to correct an amount, reverse it and record the right one.
CREATE OR REPLACE FUNCTION admin.finance_reverse(
  p_actor uuid, p_entry_id bigint, p_reason text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_original admin.finance_entries%ROWTYPE;
  v_existing admin.finance_entries%ROWTYPE;
  v_reason text;
  v_id bigint;
BEGIN
  PERFORM admin.finance_require_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  v_reason := admin.finance_check_label(p_reason);

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.finance'));
  SELECT * INTO v_existing FROM admin.finance_entries WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.reverses_id IS DISTINCT FROM p_entry_id OR v_existing.label <> v_reason THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'reverses_id', p_entry_id, 'replayed', true);
  END IF;

  SELECT * INTO v_original FROM admin.finance_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown_finance_entry' USING ERRCODE = '22023';
  END IF;
  IF v_original.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_entry_is_reversal' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM admin.finance_entries WHERE reverses_id = p_entry_id) THEN
    RAISE EXCEPTION 'finance_entry_already_reversed' USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.finance_entries(recorded_by, direction, category, period_month, amount_minor, currency, label, reverses_id, idempotency_key)
  VALUES (p_actor, v_original.direction, v_original.category, v_original.period_month, -v_original.amount_minor,
    v_original.currency, v_reason, p_entry_id, p_idempotency_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'reverses_id', p_entry_id, 'replayed', false);
END
$function$;

-- Monthly totals per currency (currencies are never converted into each
-- other), category totals for the window, and the newest rows. The role,
-- never the person: who wrote each row is in the audit log.
CREATE OR REPLACE FUNCTION admin.finance_summary(p_months integer DEFAULT 12)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  WITH window_start AS (
    SELECT (date_trunc('month', now()) - make_interval(months => least(greatest(coalesce(p_months, 12), 1), 36) - 1))::date AS since
  ),
  scoped AS (
    SELECT e.* FROM admin.finance_entries e, window_start w WHERE e.period_month >= w.since
  )
  SELECT jsonb_build_object(
    'as_of', now(),
    'since', (SELECT since FROM window_start),
    'sources', jsonb_build_object(
      'manual', 'connected',
      'shop_payments', 'not_connected',
      'token_income', 'not_connected'
    ),
    'totals', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'currency', currency,
        'expense_minor', expense, 'income_minor', income, 'net_minor', income - expense
      ) ORDER BY currency)
      FROM (
        SELECT currency,
          coalesce(sum(amount_minor) FILTER (WHERE direction = 'expense'), 0) AS expense,
          coalesce(sum(amount_minor) FILTER (WHERE direction = 'income'), 0) AS income
        FROM scoped GROUP BY currency
      ) t
    ), '[]'::jsonb),
    'months', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'month', to_char(period_month, 'YYYY-MM'), 'currency', currency,
        'expense_minor', expense, 'income_minor', income, 'net_minor', income - expense
      ) ORDER BY period_month DESC, currency)
      FROM (
        SELECT period_month, currency,
          coalesce(sum(amount_minor) FILTER (WHERE direction = 'expense'), 0) AS expense,
          coalesce(sum(amount_minor) FILTER (WHERE direction = 'income'), 0) AS income
        FROM scoped GROUP BY period_month, currency
      ) m
    ), '[]'::jsonb),
    'categories', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'direction', direction, 'category', category, 'currency', currency, 'amount_minor', total
      ) ORDER BY direction, total DESC, category)
      FROM (
        SELECT direction, category, currency, sum(amount_minor) AS total
        FROM scoped GROUP BY direction, category, currency
      ) c
    ), '[]'::jsonb),
    'entries', coalesce((
      SELECT jsonb_agg(item ORDER BY recorded_at DESC, id DESC)
      FROM (
        SELECT e.id, e.recorded_at, jsonb_build_object(
          'id', e.id,
          'recorded_at', e.recorded_at,
          'direction', e.direction,
          'category', e.category,
          'month', to_char(e.period_month, 'YYYY-MM'),
          'amount_minor', e.amount_minor,
          'currency', e.currency,
          'label', e.label,
          'reverses_id', e.reverses_id,
          'reversed', EXISTS (SELECT 1 FROM admin.finance_entries r WHERE r.reverses_id = e.id)
        ) AS item
        FROM admin.finance_entries e
        ORDER BY e.recorded_at DESC, e.id DESC
        LIMIT 200
      ) newest
    ), '[]'::jsonb)
  );
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
    'simulation_run', 'incident_record', 'support_ticket', 'finance_record'
  ));
END
$audit_kinds$;

-- Append-only by privilege: the panel role reads the table and writes only
-- through the founder-checked functions.
REVOKE ALL ON admin.finance_entries FROM PUBLIC;
GRANT SELECT ON admin.finance_entries TO heroloop_admin;

REVOKE ALL ON FUNCTION admin.finance_require_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.finance_check_label(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.finance_record(uuid, text, text, date, bigint, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.finance_reverse(uuid, bigint, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.finance_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.finance_record(uuid, text, text, date, bigint, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.finance_reverse(uuid, bigint, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.finance_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.finance_record(uuid, text, text, date, bigint, text, text, uuid) IS
  'Founder only: records one cost or income for one month; idempotent by key.';
COMMENT ON FUNCTION admin.finance_reverse(uuid, bigint, text, uuid) IS
  'Founder only: undoes one entry with a single negative reversal row; idempotent by key.';
COMMENT ON FUNCTION admin.finance_summary(integer) IS
  'Finance totals per currency and month, category totals and the newest rows; roles never people.';
