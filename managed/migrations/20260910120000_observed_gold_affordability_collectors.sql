-- Install the observed Gold affordability collectors behind a separate disabled gate.
-- No schedule is installed here; Stage 4 owns VPS1 activation after deployment QA.

ALTER TABLE telemetry.economy_collector_settings
  ADD COLUMN observed_gold_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE telemetry.economy_rollups
  DROP CONSTRAINT economy_rollups_pkey,
  DROP CONSTRAINT economy_rollups_aggregate_id_check,
  DROP CONSTRAINT economy_rollups_metric,
  ADD COLUMN location integer NOT NULL DEFAULT 0 CHECK (location BETWEEN 0 AND 20),
  ADD COLUMN formation_size integer NOT NULL DEFAULT 0 CHECK (formation_size BETWEEN 0 AND 3),
  ADD COLUMN reward_active_seconds_band text NOT NULL DEFAULT 'not_applicable' CHECK (
    reward_active_seconds_band IN ('not_applicable', '0-899', '900-3599', '3600-14399', '14400-28799', '28800+')
  ),
  ADD COLUMN gold_bonus_band text NOT NULL DEFAULT 'not_applicable' CHECK (
    gold_bonus_band IN ('not_applicable', '0%', '0.001-24.999%', '25-49.999%', '50-99.999%', '100-199.999%', '200%+')
  ),
  ADD CONSTRAINT economy_rollups_aggregate_id_check CHECK (aggregate_id IN (
    'currency_faucet', 'currency_sink', 'loot_distribution', 'chest_flow',
    'inventory_saturation', 'currency_balance', 'gold_affordability', 'enchant_allocation',
    'currency_transfer', 'progression_flow', 'resource_flow', 'hero_flow', 'item_flow',
    'hero_ledger_reconciliation'
  )),
  ADD CONSTRAINT economy_rollups_metric CHECK (
    (aggregate_id IN ('currency_faucet', 'currency_sink', 'progression_flow', 'resource_flow')
      AND metric_id IN ('event_count', 'amount'))
    OR (aggregate_id = 'loot_distribution' AND metric_id = 'item_count')
    OR (aggregate_id = 'chest_flow' AND metric_id IN ('granted', 'opened', 'blocked_capacity'))
    OR (aggregate_id = 'inventory_saturation' AND metric_id = 'sample_count')
    OR (aggregate_id = 'currency_balance' AND metric_id IN ('account_count', 'total', 'minimum', 'maximum'))
    OR (aggregate_id = 'gold_affordability' AND metric_id IN ('account_count', 'gold_p50', 'gold_p75', 'gold_p90'))
    OR (aggregate_id = 'enchant_allocation' AND metric_id IN (
      'account_count', 'gross_gold', 'enchant_gold',
      'allocation_percent_p50', 'allocation_percent_p75', 'allocation_percent_p90'
    ))
    OR (aggregate_id = 'currency_transfer' AND metric_id IN ('event_count', 'gross_amount', 'fee_amount'))
    OR (aggregate_id = 'hero_flow' AND metric_id IN ('created', 'consumed'))
    OR (aggregate_id = 'item_flow' AND metric_id IN ('created', 'removed', 'destroyed', 'sold'))
    OR (aggregate_id = 'hero_ledger_reconciliation' AND metric_id IN (
      'expected_player_balance', 'actual_player_balance', 'drift', 'source_gap_count', 'duplicate_key_count'
    ))
  ),
  ADD PRIMARY KEY (
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, inventory_fill_band, currency, progression_kind,
    resource_kind, flow_direction, activity_mode, chest_kind, rarity, source_kind,
    location, formation_size, reward_active_seconds_band, gold_bonus_band
  );

CREATE TABLE public.gold_grant_events (
  source_key text PRIMARY KEY CHECK (char_length(source_key) BETWEEN 12 AND 160),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind IN ('starter_gold', 'tester_gold')),
  amount bigint NOT NULL CHECK (amount > 0 AND amount <= 10000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  economy_balance_version text,
  economy_account_level_band text CHECK (economy_account_level_band IS NULL OR economy_account_level_band IN (
    '1-9', '10-19', '20-39', '40-59', '60-79', '80-99'
  )),
  CHECK (economy_balance_version IS NULL OR economy_balance_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$')
);
CREATE INDEX gold_grant_events_telemetry_hour
  ON public.gold_grant_events(occurred_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
ALTER TABLE public.gold_grant_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gold_grant_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gold_grant_events FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.gold_grant_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');

CREATE OR REPLACE FUNCTION telemetry.capture_starter_gold_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE v_enabled boolean;
BEGIN
  SELECT enabled AND observed_gold_enabled INTO v_enabled
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) OR NEW.imported_legacy
    OR COALESCE(NEW.state->>'gold', '') <> '500'
    OR COALESCE(NEW.state->>'accountLevel', '') <> '1' THEN RETURN NEW; END IF;
  BEGIN
    INSERT INTO public.gold_grant_events(source_key, player_id, source_kind, amount)
    VALUES ('starter-gold:' || NEW.player_id::text, NEW.player_id, 'starter_gold', 500)
    ON CONFLICT (source_key) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION telemetry.capture_starter_gold_event() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER capture_starter_gold_event AFTER INSERT ON public.player_saves
FOR EACH ROW EXECUTE FUNCTION telemetry.capture_starter_gold_event();

ALTER FUNCTION public.credit_tester_gold(uuid, bigint)
  RENAME TO credit_tester_gold_before_observed_telemetry;
REVOKE ALL ON FUNCTION public.credit_tester_gold_before_observed_telemetry(uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.credit_tester_gold(p_player_id uuid, p_amount bigint DEFAULT 10000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_result jsonb;
  v_enabled boolean;
BEGIN
  v_result := public.credit_tester_gold_before_observed_telemetry(p_player_id, p_amount);
  SELECT enabled AND observed_gold_enabled INTO v_enabled
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF COALESCE(v_enabled, false) THEN
    BEGIN
      INSERT INTO public.gold_grant_events(source_key, player_id, source_kind, amount)
      VALUES (
        'tester-gold:' || p_player_id::text || ':' || (v_result->>'revision'),
        p_player_id, 'tester_gold', p_amount
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.credit_tester_gold(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_tester_gold(uuid, bigint) TO service_role;

CREATE OR REPLACE FUNCTION telemetry.reward_active_seconds_band(p_seconds numeric)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_seconds < 900 THEN '0-899'
    WHEN p_seconds < 3600 THEN '900-3599'
    WHEN p_seconds < 14400 THEN '3600-14399'
    WHEN p_seconds < 28800 THEN '14400-28799' ELSE '28800+' END
$$;

CREATE OR REPLACE FUNCTION telemetry.gold_bonus_band(p_bonus numeric)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_bonus = 0 THEN '0%'
    WHEN p_bonus < .25 THEN '0.001-24.999%'
    WHEN p_bonus < .5 THEN '25-49.999%'
    WHEN p_bonus < 1 THEN '50-99.999%'
    WHEN p_bonus < 2 THEN '100-199.999%' ELSE '200%+' END
$$;
REVOKE ALL ON FUNCTION telemetry.reward_active_seconds_band(numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.gold_bonus_band(numeric) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION telemetry.collect_gold_grant_hour(p_bucket_start timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_enabled boolean;
  v_environment text;
  v_rows integer;
BEGIN
  SELECT enabled AND observed_gold_enabled, environment INTO v_enabled, v_environment
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RAISE EXCEPTION 'observed_gold_collectors_disabled'; END IF;
  IF p_bucket_start <> date_trunc('hour', p_bucket_start) OR p_bucket_start >= date_trunc('hour', now()) THEN
    RAISE EXCEPTION 'economy_collector_requires_completed_utc_hour';
  END IF;
  WITH grouped AS (
    SELECT economy_balance_version AS balance_version, economy_account_level_band AS account_level_band,
      source_kind, count(*)::numeric AS event_count, sum(amount)::numeric AS amount,
      count(DISTINCT player_id)::integer AS cohort_accounts
    FROM public.gold_grant_events
    WHERE occurred_at >= p_bucket_start AND occurred_at < p_bucket_start + interval '1 hour'
      AND economy_balance_version IS NOT NULL AND economy_account_level_band IS NOT NULL
    GROUP BY economy_balance_version, economy_account_level_band, source_kind
    HAVING count(DISTINCT player_id) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, currency, activity_mode, source_kind, metric_value, cohort_accounts
  )
  SELECT 'hour', p_bucket_start AT TIME ZONE 'UTC', v_environment, balance_version,
    'currency_faucet', metric.metric_id, account_level_band, 'gold', 'not_applicable',
    source_kind, metric.metric_value, cohort_accounts
  FROM grouped CROSS JOIN LATERAL (VALUES
    ('event_count'::text, event_count), ('amount'::text, amount)
  ) metric(metric_id, metric_value)
  ON CONFLICT ON CONSTRAINT economy_rollups_pkey DO UPDATE SET
    metric_value = EXCLUDED.metric_value, cohort_accounts = EXCLUDED.cohort_accounts, computed_at = now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry.collect_observed_gold_day(p_day date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_enabled boolean;
  v_environment text;
  v_rows integer := 0;
  v_added integer;
BEGIN
  SELECT enabled AND observed_gold_enabled, environment INTO v_enabled, v_environment
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RAISE EXCEPTION 'observed_gold_collectors_disabled'; END IF;
  IF p_day IS NULL OR p_day >= (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'economy_rollup_requires_completed_utc_day';
  END IF;
  DELETE FROM telemetry.economy_rollups
  WHERE period_kind = 'day' AND bucket_start_utc = p_day::timestamp
    AND environment = v_environment AND aggregate_id IN ('gold_affordability', 'enchant_allocation');

  WITH event_base AS (
    SELECT event.player_id, event.economy_balance_version AS balance_version,
      event.economy_account_level_band AS account_level_band, event.location,
      formation.size AS formation_size,
      telemetry.gold_bonus_band((event.reward_bonuses->>'gold')::numeric) AS gold_bonus_band,
      (event.result#>>'{rewards,gold}')::numeric AS gold,
      (event.result#>>'{rewards,reward_clock_seconds}')::numeric AS reward_seconds
    FROM public.normal_combat_events event
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS size FROM jsonb_array_elements(event.initial_units) unit
      WHERE unit->>'side' = 'hero'
    ) formation
    WHERE event.completed_at >= p_day::timestamp AND event.completed_at < p_day::timestamp + interval '1 day'
      AND event.economy_balance_version IS NOT NULL AND event.economy_account_level_band IS NOT NULL
      AND event.location BETWEEN 1 AND 20 AND formation.size BETWEEN 1 AND 3
      AND COALESCE(event.reward_bonuses->>'gold', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND COALESCE(event.result#>>'{rewards,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND COALESCE(event.result#>>'{rewards,reward_clock_seconds}', '') ~ '^[0-9]+([.][0-9]+)?$'
  ), per_account AS (
    SELECT player_id, balance_version, account_level_band, location, formation_size, gold_bonus_band,
      sum(gold) AS gold, sum(reward_seconds) AS reward_seconds
    FROM event_base GROUP BY player_id, balance_version, account_level_band, location, formation_size, gold_bonus_band
  ), grouped AS (
    SELECT balance_version, account_level_band, location, formation_size,
      telemetry.reward_active_seconds_band(reward_seconds) AS reward_band, gold_bonus_band,
      count(*)::integer AS cohort_accounts,
      percentile_cont(.5) WITHIN GROUP (ORDER BY gold)::numeric AS gold_p50,
      percentile_cont(.75) WITHIN GROUP (ORDER BY gold)::numeric AS gold_p75,
      percentile_cont(.9) WITHIN GROUP (ORDER BY gold)::numeric AS gold_p90
    FROM per_account
    GROUP BY balance_version, account_level_band, location, formation_size,
      telemetry.reward_active_seconds_band(reward_seconds), gold_bonus_band
    HAVING count(*) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, location, formation_size, reward_active_seconds_band, gold_bonus_band,
    metric_value, cohort_accounts
  )
  SELECT 'day', p_day::timestamp, v_environment, balance_version, 'gold_affordability',
    metric.metric_id, account_level_band, location, formation_size, reward_band, gold_bonus_band,
    metric.metric_value, cohort_accounts
  FROM grouped CROSS JOIN LATERAL (VALUES
    ('account_count'::text, cohort_accounts::numeric), ('gold_p50'::text, gold_p50),
    ('gold_p75'::text, gold_p75), ('gold_p90'::text, gold_p90)
  ) metric(metric_id, metric_value);
  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_rows := v_rows + v_added;

  WITH faucets AS (
    SELECT player_id, economy_balance_version AS balance_version, economy_account_level_band AS account_level_band,
      amount::numeric AS amount FROM public.gold_grant_events
    WHERE occurred_at >= p_day::timestamp AND occurred_at < p_day::timestamp + interval '1 day'
    UNION ALL
    SELECT player_id, economy_balance_version, economy_account_level_band,
      (result#>>'{rewards,gold}')::numeric FROM public.normal_combat_events
    WHERE completed_at >= p_day::timestamp AND completed_at < p_day::timestamp + interval '1 day'
      AND COALESCE(result#>>'{rewards,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
    UNION ALL
    SELECT player_id, economy_balance_version, economy_account_level_band, (result->>'gold')::numeric
    FROM public.quest_claim_events WHERE created_at >= p_day::timestamp AND created_at < p_day::timestamp + interval '1 day'
      AND COALESCE(result->>'gold', '') ~ '^[0-9]+([.][0-9]+)?$'
    UNION ALL
    SELECT player_id, economy_balance_version, economy_account_level_band, (result#>>'{reward,gold}')::numeric
    FROM public.tutorial_quest_claim_events WHERE created_at >= p_day::timestamp AND created_at < p_day::timestamp + interval '1 day'
      AND COALESCE(result#>>'{reward,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
    UNION ALL
    SELECT player_id, economy_balance_version, economy_account_level_band, (result#>>'{rewards,gold}')::numeric
    FROM public.promo_code_redemptions WHERE redeemed_at >= p_day::timestamp AND redeemed_at < p_day::timestamp + interval '1 day'
      AND COALESCE(result#>>'{rewards,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
    UNION ALL
    SELECT player_id, economy_balance_version, economy_account_level_band, (result->>'gold_refund')::numeric
    FROM public.item_mutation_events WHERE created_at >= p_day::timestamp AND created_at < p_day::timestamp + interval '1 day'
      AND action_kind = 'sell' AND COALESCE(result->>'gold_refund', '') ~ '^[0-9]+([.][0-9]+)?$'
    UNION ALL
    SELECT player_id, economy_balance_version, economy_account_level_band, (result->>'gold')::numeric
    FROM public.boss_claim_events WHERE created_at >= p_day::timestamp AND created_at < p_day::timestamp + interval '1 day'
      AND COALESCE(result->>'gold', '') ~ '^[0-9]+([.][0-9]+)?$'
  ), gross AS (
    SELECT player_id, balance_version, account_level_band, sum(amount) AS gross_gold
    FROM faucets WHERE amount > 0 AND balance_version IS NOT NULL AND account_level_band IS NOT NULL
    GROUP BY player_id, balance_version, account_level_band
  ), enchant AS (
    SELECT player_id, economy_balance_version AS balance_version,
      economy_account_level_band AS account_level_band, sum((result->>'gold_cost')::numeric) AS enchant_gold
    FROM public.item_upgrade_events
    WHERE created_at >= p_day::timestamp AND created_at < p_day::timestamp + interval '1 day'
      AND action_kind = 'enchant' AND COALESCE(result->>'gold_cost', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND economy_balance_version IS NOT NULL AND economy_account_level_band IS NOT NULL
    GROUP BY player_id, economy_balance_version, economy_account_level_band
  ), accounts AS (
    SELECT gross.balance_version, gross.account_level_band, gross.gross_gold,
      COALESCE(enchant.enchant_gold, 0) AS enchant_gold,
      COALESCE(enchant.enchant_gold, 0) * 100 / gross.gross_gold AS allocation_percent
    FROM gross LEFT JOIN enchant USING (player_id, balance_version, account_level_band)
    WHERE gross.gross_gold > 0
  ), grouped AS (
    SELECT balance_version, account_level_band, count(*)::integer AS cohort_accounts,
      sum(gross_gold) AS gross_gold, sum(enchant_gold) AS enchant_gold,
      percentile_cont(.5) WITHIN GROUP (ORDER BY allocation_percent)::numeric AS allocation_p50,
      percentile_cont(.75) WITHIN GROUP (ORDER BY allocation_percent)::numeric AS allocation_p75,
      percentile_cont(.9) WITHIN GROUP (ORDER BY allocation_percent)::numeric AS allocation_p90
    FROM accounts GROUP BY balance_version, account_level_band HAVING count(*) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, metric_value, cohort_accounts
  )
  SELECT 'day', p_day::timestamp, v_environment, balance_version, 'enchant_allocation',
    metric.metric_id, account_level_band, metric.metric_value, cohort_accounts
  FROM grouped CROSS JOIN LATERAL (VALUES
    ('account_count'::text, cohort_accounts::numeric), ('gross_gold'::text, gross_gold),
    ('enchant_gold'::text, enchant_gold), ('allocation_percent_p50'::text, allocation_p50),
    ('allocation_percent_p75'::text, allocation_p75), ('allocation_percent_p90'::text, allocation_p90)
  ) metric(metric_id, metric_value);
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_rows + v_added;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry.run_observed_gold_collection(p_requested_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, telemetry
SET timezone = 'UTC'
AS $$
DECLARE
  v_enabled boolean;
  v_tick timestamptz;
  v_hour_rows integer;
  v_day_rows integer := 0;
BEGIN
  IF p_requested_at IS NULL OR p_requested_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_economy_collection_tick';
  END IF;
  SELECT enabled AND observed_gold_enabled INTO v_enabled
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN jsonb_build_object('status', 'disabled'); END IF;
  v_tick := date_trunc('hour', p_requested_at);
  v_hour_rows := telemetry.collect_gold_grant_hour(v_tick - interval '1 hour');
  IF extract(hour FROM v_tick) = 0 THEN
    PERFORM telemetry.rollup_economy_day((v_tick AT TIME ZONE 'UTC')::date - 1);
    v_day_rows := telemetry.collect_observed_gold_day((v_tick AT TIME ZONE 'UTC')::date - 1);
  END IF;
  RETURN jsonb_build_object('status', 'collected', 'hour_rows', v_hour_rows, 'day_rows', v_day_rows);
END;
$$;

REVOKE ALL ON FUNCTION telemetry.collect_gold_grant_hour(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.collect_observed_gold_day(date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.run_observed_gold_collection(timestamptz) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.gold_grant_events IS
  'Private immutable starter/tester Gold settlement evidence; never exposed as telemetry rows.';
COMMENT ON FUNCTION telemetry.collect_observed_gold_day(date) IS
  'Disabled-by-default identifier-free daily Gold percentiles and Enchant allocation cohorts.';
COMMENT ON FUNCTION telemetry.run_observed_gold_collection(timestamptz) IS
  'Private observed-Gold orchestrator; no schedule is installed by this migration.';
