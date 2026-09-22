-- Stage 2: install private currency faucet/sink collectors without activating collection.
-- Existing settlement ledgers remain authoritative; telemetry stores identifier-free cohorts only.
CREATE TABLE telemetry.economy_collector_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  environment text CHECK (environment IN ('staging', 'production')),
  balance_version text CHECK (
    balance_version IS NULL OR balance_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (environment IS NOT NULL AND balance_version IS NOT NULL))
);

INSERT INTO telemetry.economy_collector_settings(singleton, enabled)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE telemetry.economy_collector_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.economy_collector_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telemetry.economy_collector_settings FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION telemetry.account_level_band(p_level integer)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_level BETWEEN 1 AND 9 THEN '1-9'
    WHEN p_level BETWEEN 10 AND 19 THEN '10-19'
    WHEN p_level BETWEEN 20 AND 39 THEN '20-39'
    WHEN p_level BETWEEN 40 AND 59 THEN '40-59'
    WHEN p_level BETWEEN 60 AND 79 THEN '60-79'
    WHEN p_level BETWEEN 80 AND 99 THEN '80-99'
  END
$$;

-- Attribution is written beside the authoritative event, never into a player-level telemetry table.
-- Invalid/missing telemetry configuration is skipped and can never fail the settlement itself.
CREATE OR REPLACE FUNCTION telemetry.stamp_economy_settlement()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_enabled boolean;
  v_config_version text;
  v_version text;
  v_player_id uuid;
  v_level_text text;
  v_band text;
BEGIN
  SELECT enabled, balance_version INTO v_enabled, v_config_version
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NEW; END IF;

  v_version := CASE WHEN TG_ARGV[0] = 'row_balance_version'
    THEN to_jsonb(NEW)->>'balance_version' ELSE v_config_version END;
  IF v_version IS NULL OR v_version NOT IN (
    '2026.08.02-v2',
    'hero-power-proposal-2026.08.12-v3',
    'balance-v4',
    'balance-v4-2026.09.01-v6-combat-effects-v1',
    'balance-v4-2026.09.06-v7-combat-effects-v2-candidate'
  ) THEN RETURN NEW; END IF;

  BEGIN
    v_player_id := (to_jsonb(NEW)->>'player_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;
  IF v_player_id IS NULL THEN RETURN NEW; END IF;

  SELECT state->>'accountLevel' INTO v_level_text
  FROM public.player_saves WHERE player_id = v_player_id;
  IF v_level_text IS NULL OR v_level_text !~ '^[0-9]{1,3}$' THEN RETURN NEW; END IF;
  v_band := telemetry.account_level_band(v_level_text::integer);
  IF v_band IS NULL THEN RETURN NEW; END IF;

  NEW := jsonb_populate_record(NEW, jsonb_build_object(
    'economy_balance_version', v_version,
    'economy_account_level_band', v_band
  ));
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION telemetry.account_level_band(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.stamp_economy_settlement() FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.hero_economy_ledger
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.normal_combat_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.quest_claim_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.tutorial_quest_claim_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.promo_code_redemptions
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.item_mutation_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.store_purchase_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.item_upgrade_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;
ALTER TABLE public.boss_claim_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text;

DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'hero_economy_ledger', 'normal_combat_events', 'quest_claim_events',
    'tutorial_quest_claim_events', 'promo_code_redemptions', 'item_mutation_events',
    'store_purchase_events', 'item_upgrade_events', 'boss_claim_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (economy_balance_version IS NULL OR economy_balance_version ~ %L)',
      v_table, v_table || '_economy_version_check', '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (economy_account_level_band IS NULL OR economy_account_level_band IN (%L,%L,%L,%L,%L,%L))',
      v_table, v_table || '_economy_level_band_check', '1-9', '10-19', '20-39', '40-59', '60-79', '80-99');
  END LOOP;
END;
$$;

CREATE INDEX hero_economy_ledger_telemetry_hour
  ON public.hero_economy_ledger(occurred_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX normal_combat_events_telemetry_hour
  ON public.normal_combat_events(completed_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL AND completed_at IS NOT NULL;
CREATE INDEX quest_claim_events_telemetry_hour
  ON public.quest_claim_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX tutorial_quest_claim_events_telemetry_hour
  ON public.tutorial_quest_claim_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX promo_code_redemptions_telemetry_hour
  ON public.promo_code_redemptions(redeemed_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX item_mutation_events_telemetry_hour
  ON public.item_mutation_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX store_purchase_events_telemetry_hour
  ON public.store_purchase_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX item_upgrade_events_telemetry_hour
  ON public.item_upgrade_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX boss_claim_events_telemetry_hour
  ON public.boss_claim_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;

DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.hero_economy_ledger;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.hero_economy_ledger
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.normal_combat_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.normal_combat_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('row_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.quest_claim_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.quest_claim_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.tutorial_quest_claim_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.tutorial_quest_claim_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.promo_code_redemptions;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.promo_code_redemptions
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.item_mutation_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.item_mutation_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.store_purchase_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.store_purchase_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.item_upgrade_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.item_upgrade_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.boss_claim_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.boss_claim_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');

-- Recomputes one completed UTC hour from immutable server settlement inputs.
-- It deliberately emits nothing below the configured five-account privacy cohort.
CREATE OR REPLACE FUNCTION telemetry.collect_currency_settlement_hour(p_bucket_start timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_environment text;
  v_enabled boolean;
  v_rows integer;
BEGIN
  SELECT enabled, environment INTO v_enabled, v_environment
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RAISE EXCEPTION 'economy_collectors_disabled'; END IF;
  IF p_bucket_start <> date_trunc('hour', p_bucket_start) OR p_bucket_start >= date_trunc('hour', now()) THEN
    RAISE EXCEPTION 'economy_collector_requires_completed_utc_hour';
  END IF;

  WITH settlement AS (
    SELECT ledger.source_key AS event_key, ledger.player_id, ledger.occurred_at,
      ledger.economy_balance_version AS balance_version,
      ledger.economy_account_level_band AS account_level_band,
      CASE WHEN ledger.flow = 'player_issuance' THEN 'currency_faucet' ELSE 'currency_sink' END AS aggregate_id,
      'hero'::text AS currency, 'not_applicable'::text AS activity_mode,
      CASE ledger.source_kind
        WHEN 'promo_code' THEN 'promo_hero' WHEN 'quest-reward' THEN 'daily_quest_hero'
        WHEN 'hero-summon' THEN 'paid_summon_hero' WHEN 'hero-ascension' THEN 'ascension_hero'
        WHEN 'training-slot' THEN 'training_hero' WHEN 'training-boost-2x-1h' THEN 'training_hero'
        WHEN 'training-boost-2x-4h' THEN 'training_hero' WHEN 'training-boost-4x-1h' THEN 'training_hero'
        WHEN 'training-boost-4x-4h' THEN 'training_hero' WHEN 'item-enchant' THEN 'enchant_hero'
        WHEN 'enchant-charm' THEN 'enchant_hero' WHEN 'item-reroll' THEN 'reroll_hero'
      END AS source_kind,
      ledger.amount
    FROM public.hero_economy_ledger ledger
    WHERE ledger.occurred_at >= p_bucket_start AND ledger.occurred_at < p_bucket_start + interval '1 hour'
      AND ledger.player_id IS NOT NULL AND ledger.source_kind <> 'market_fee'

    UNION ALL
    SELECT event.start_key::text, event.player_id, event.completed_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_faucet', 'gold', 'visible', 'combat_wave_gold',
      (event.result#>>'{rewards,gold}')::numeric
    FROM public.normal_combat_events event
    WHERE event.completed_at >= p_bucket_start AND event.completed_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result#>>'{rewards,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND (event.result#>>'{rewards,gold}')::numeric > 0

    UNION ALL
    SELECT event.start_key::text || ':auto-pot', event.player_id, event.completed_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_sink', 'gold', 'visible', 'potion_gold',
      (event.result#>>'{auto_pot,gold_spent}')::numeric
    FROM public.normal_combat_events event
    WHERE event.completed_at >= p_bucket_start AND event.completed_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result#>>'{auto_pot,gold_spent}', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND (event.result#>>'{auto_pot,gold_spent}')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_faucet', 'gold', 'not_applicable', 'daily_quest_gold',
      (event.result->>'gold')::numeric
    FROM public.quest_claim_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result->>'gold', '') ~ '^[0-9]+([.][0-9]+)?$' AND (event.result->>'gold')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_faucet', 'gold', 'not_applicable', 'tutorial_quest_gold',
      (event.result#>>'{reward,gold}')::numeric
    FROM public.tutorial_quest_claim_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result#>>'{reward,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND (event.result#>>'{reward,gold}')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.redeemed_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_faucet', 'gold', 'not_applicable', 'promo_gold',
      (event.result#>>'{rewards,gold}')::numeric
    FROM public.promo_code_redemptions event
    WHERE event.redeemed_at >= p_bucket_start AND event.redeemed_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result#>>'{rewards,gold}', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND (event.result#>>'{rewards,gold}')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_faucet', 'gold', 'not_applicable', 'item_sale_gold',
      (event.result->>'gold_refund')::numeric
    FROM public.item_mutation_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND event.action_kind = 'sell' AND COALESCE(event.result->>'gold_refund', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND (event.result->>'gold_refund')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_sink', 'gold', 'not_applicable', 'store_gold',
      (event.result->>'price')::numeric
    FROM public.store_purchase_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result->>'price', '') ~ '^[0-9]+([.][0-9]+)?$' AND (event.result->>'price')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_sink', 'gold', 'not_applicable', 'enchant_gold',
      (event.result->>'gold_cost')::numeric
    FROM public.item_upgrade_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND event.action_kind = 'enchant' AND COALESCE(event.result->>'gold_cost', '') ~ '^[0-9]+([.][0-9]+)?$'
      AND (event.result->>'gold_cost')::numeric > 0

    UNION ALL
    SELECT event.idempotency_key::text, event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'currency_faucet', 'gold', 'not_applicable', 'boss_combat_gold',
      (event.result->>'gold')::numeric
    FROM public.boss_claim_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result->>'gold', '') ~ '^[0-9]+([.][0-9]+)?$' AND (event.result->>'gold')::numeric > 0
  ), grouped AS (
    SELECT balance_version, account_level_band, aggregate_id, currency, activity_mode, source_kind,
      count(*)::numeric AS event_count, sum(amount)::numeric AS amount,
      count(DISTINCT player_id)::integer AS cohort_accounts
    FROM settlement
    WHERE balance_version IS NOT NULL AND account_level_band IS NOT NULL AND source_kind IS NOT NULL
    GROUP BY balance_version, account_level_band, aggregate_id, currency, activity_mode, source_kind
    HAVING count(DISTINCT player_id) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, currency, activity_mode, source_kind, metric_value, cohort_accounts
  )
  SELECT 'hour', p_bucket_start AT TIME ZONE 'UTC', v_environment, grouped.balance_version,
    grouped.aggregate_id, metric.metric_id, grouped.account_level_band, grouped.currency,
    grouped.activity_mode, grouped.source_kind, metric.metric_value, grouped.cohort_accounts
  FROM grouped
  CROSS JOIN LATERAL (VALUES ('event_count', grouped.event_count), ('amount', grouped.amount)) metric(metric_id, metric_value)
  ON CONFLICT ON CONSTRAINT economy_rollups_pkey DO UPDATE SET
    metric_value = EXCLUDED.metric_value,
    cohort_accounts = EXCLUDED.cohort_accounts,
    computed_at = now();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION telemetry.collect_currency_settlement_hour(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE telemetry.economy_collector_settings IS
  'Root-operated economy telemetry gate; installed disabled and not exposed to browser/API/worker roles.';
COMMENT ON FUNCTION telemetry.collect_currency_settlement_hour(timestamptz) IS
  'Private idempotent hourly currency collector; scheduling and Staging activation are later approval-paced stages.';
