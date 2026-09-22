-- Identifier-free storage foundation only. Collectors and runtime writes are added separately.
CREATE SCHEMA IF NOT EXISTS telemetry;
REVOKE ALL ON SCHEMA telemetry FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE telemetry.economy_rollups (
  period_kind text NOT NULL CHECK (period_kind IN ('hour', 'day')),
  bucket_start_utc timestamp without time zone NOT NULL,
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  balance_version text NOT NULL CHECK (balance_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
  aggregate_id text NOT NULL CHECK (aggregate_id IN (
    'currency_faucet', 'currency_sink', 'loot_distribution', 'chest_flow',
    'inventory_saturation', 'currency_balance', 'currency_transfer', 'progression_flow',
    'resource_flow', 'hero_flow', 'item_flow', 'hero_ledger_reconciliation'
  )),
  metric_id text NOT NULL,
  account_level_band text NOT NULL DEFAULT 'not_applicable' CHECK (account_level_band IN (
    'not_applicable', '1-9', '10-19', '20-39', '40-59', '60-79', '80-99'
  )),
  item_level_band text NOT NULL DEFAULT 'not_applicable' CHECK (item_level_band IN (
    'not_applicable', '1-9', '10-19', '20-39', '40-59', '60-79', '80-99'
  )),
  inventory_fill_band text NOT NULL DEFAULT 'not_applicable' CHECK (inventory_fill_band IN (
    'not_applicable', '0-24%', '25-49%', '50-74%', '75-89%', '90-99%', '100%'
  )),
  currency text NOT NULL DEFAULT 'not_applicable' CHECK (currency IN ('not_applicable', 'gold', 'hero')),
  progression_kind text NOT NULL DEFAULT 'not_applicable' CHECK (
    progression_kind IN ('not_applicable', 'account_xp', 'hero_xp')
  ),
  resource_kind text NOT NULL DEFAULT 'not_applicable' CHECK (resource_kind IN (
    'not_applicable', 'potion_xs', 'potion_sm', 'potion_md', 'potion_lg', 'potion_xl',
    'potion_xxl', 'boss_key', 'summon_scroll', 'tutorial_chest', 'iron_scrap',
    'arcane_dust', 'astral_shard', 'godforged_core'
  )),
  flow_direction text NOT NULL DEFAULT 'not_applicable' CHECK (
    flow_direction IN ('not_applicable', 'faucet', 'sink', 'transfer', 'internal')
  ),
  activity_mode text NOT NULL DEFAULT 'not_applicable' CHECK (
    activity_mode IN ('not_applicable', 'visible', 'hidden', 'offline', 'boost_max')
  ),
  chest_kind text NOT NULL DEFAULT 'not_applicable' CHECK (
    chest_kind IN ('not_applicable', 'timed_standard', 'tutorial', 'boss', 'dungeon', 'event')
  ),
  rarity text NOT NULL DEFAULT 'not_applicable' CHECK (rarity IN (
    'not_applicable', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
    'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'
  )),
  source_kind text NOT NULL DEFAULT 'not_applicable' CHECK (
    source_kind = 'not_applicable' OR source_kind ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  metric_value numeric(38,6) NOT NULL CHECK (metric_value >= 0 OR metric_id = 'drift'),
  cohort_accounts integer NOT NULL CHECK (cohort_accounts >= 0),
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT economy_rollups_metric CHECK (
    (aggregate_id IN ('currency_faucet', 'currency_sink', 'progression_flow', 'resource_flow')
      AND metric_id IN ('event_count', 'amount'))
    OR (aggregate_id = 'loot_distribution' AND metric_id = 'item_count')
    OR (aggregate_id = 'chest_flow' AND metric_id IN ('granted', 'opened', 'blocked_capacity'))
    OR (aggregate_id = 'inventory_saturation' AND metric_id = 'sample_count')
    OR (aggregate_id = 'currency_balance' AND metric_id IN ('account_count', 'total', 'minimum', 'maximum'))
    OR (aggregate_id = 'currency_transfer' AND metric_id IN ('event_count', 'gross_amount', 'fee_amount'))
    OR (aggregate_id = 'hero_flow' AND metric_id IN ('created', 'consumed'))
    OR (aggregate_id = 'item_flow' AND metric_id IN ('created', 'removed', 'destroyed', 'sold'))
    OR (aggregate_id = 'hero_ledger_reconciliation' AND metric_id IN (
      'expected_player_balance', 'actual_player_balance', 'drift', 'source_gap_count', 'duplicate_key_count'
    ))
  ),
  CONSTRAINT economy_rollups_bucket_alignment CHECK (
    extract(minute FROM bucket_start_utc) = 0
    AND extract(second FROM bucket_start_utc) = 0
    AND (period_kind = 'hour' OR extract(hour FROM bucket_start_utc) = 0)
  ),
  PRIMARY KEY (
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, inventory_fill_band, currency, progression_kind,
    resource_kind, flow_direction, activity_mode, chest_kind, rarity, source_kind
  )
);

CREATE INDEX economy_rollups_retention ON telemetry.economy_rollups(period_kind, bucket_start_utc);
CREATE INDEX economy_rollups_lookup ON telemetry.economy_rollups(
  environment, balance_version, aggregate_id, bucket_start_utc DESC
);

ALTER TABLE telemetry.economy_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.economy_rollups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE telemetry.economy_rollups FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE telemetry.economy_rollups IS
  'Identifier-free economy aggregates; no collector or runtime writer is enabled by this migration.';
