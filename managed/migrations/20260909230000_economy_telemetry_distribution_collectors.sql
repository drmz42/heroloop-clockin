-- Stage 3: install private loot/chest event and Inventory/currency snapshot collectors.
-- All collector execution remains behind the disabled stage-2 root-operated gate.

CREATE OR REPLACE FUNCTION telemetry.item_level_band(p_level integer)
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

CREATE OR REPLACE FUNCTION telemetry.inventory_fill_band(p_count integer, p_capacity integer)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_capacity <= 0 THEN NULL
    WHEN p_count >= p_capacity THEN '100%'
    WHEN p_count * 100 < p_capacity * 25 THEN '0-24%'
    WHEN p_count * 100 < p_capacity * 50 THEN '25-49%'
    WHEN p_count * 100 < p_capacity * 75 THEN '50-74%'
    WHEN p_count * 100 < p_capacity * 90 THEN '75-89%'
    ELSE '90-99%'
  END
$$;

REVOKE ALL ON FUNCTION telemetry.item_level_band(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.inventory_fill_band(integer, integer) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.chest_open_events
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text,
  ADD CONSTRAINT chest_open_events_economy_version_check CHECK (
    economy_balance_version IS NULL OR economy_balance_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
  ),
  ADD CONSTRAINT chest_open_events_economy_level_band_check CHECK (
    economy_account_level_band IS NULL OR economy_account_level_band IN (
      '1-9', '10-19', '20-39', '40-59', '60-79', '80-99'
    )
  );

ALTER TABLE public.player_items
  ADD COLUMN economy_balance_version text,
  ADD COLUMN economy_account_level_band text,
  ADD CONSTRAINT player_items_economy_version_check CHECK (
    economy_balance_version IS NULL OR economy_balance_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'
  ),
  ADD CONSTRAINT player_items_economy_level_band_check CHECK (
    economy_account_level_band IS NULL OR economy_account_level_band IN (
      '1-9', '10-19', '20-39', '40-59', '60-79', '80-99'
    )
  );

CREATE INDEX chest_open_events_telemetry_hour
  ON public.chest_open_events(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
CREATE INDEX player_items_telemetry_hour
  ON public.player_items(created_at, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;

DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.chest_open_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.chest_open_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');
DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.player_items;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.player_items
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');

-- The existing periodic settlement had no immutable chest-grant event. This narrow ledger
-- records only server-derived counts needed for chest telemetry and cannot change rewards.
CREATE TABLE public.periodic_chest_events (
  source_key text PRIMARY KEY CHECK (char_length(source_key) BETWEEN 10 AND 160),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  granted integer NOT NULL CHECK (granted BETWEEN 0 AND 500),
  blocked_capacity integer NOT NULL CHECK (blocked_capacity BETWEEN 0 AND 500),
  activity_mode text NOT NULL CHECK (activity_mode IN ('hidden', 'offline', 'boost_max')),
  settled_through timestamptz NOT NULL,
  economy_balance_version text,
  economy_account_level_band text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (granted > 0 OR blocked_capacity > 0),
  CHECK (economy_balance_version IS NULL OR economy_balance_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$'),
  CHECK (economy_account_level_band IS NULL OR economy_account_level_band IN (
    '1-9', '10-19', '20-39', '40-59', '60-79', '80-99'
  ))
);

CREATE INDEX periodic_chest_events_telemetry_hour
  ON public.periodic_chest_events(settled_through, economy_balance_version)
  WHERE economy_balance_version IS NOT NULL;
ALTER TABLE public.periodic_chest_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.periodic_chest_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.periodic_chest_events FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS stamp_economy_settlement ON public.periodic_chest_events;
CREATE TRIGGER stamp_economy_settlement BEFORE INSERT ON public.periodic_chest_events
FOR EACH ROW EXECUTE FUNCTION telemetry.stamp_economy_settlement('configured_balance_version');

ALTER FUNCTION public.settle_periodic_progression(uuid, timestamptz)
  RENAME TO settle_periodic_progression_before_economy_telemetry;
REVOKE ALL ON FUNCTION public.settle_periodic_progression_before_economy_telemetry(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.settle_periodic_progression(p_player_id uuid, p_tick timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_before_state jsonb;
  v_before_tick timestamptz;
  v_reward_until timestamptz;
  v_boost_max boolean;
  v_online boolean;
  v_result jsonb;
  v_settled_through timestamptz;
  v_seconds numeric;
  v_progress numeric;
  v_expected integer;
  v_granted integer;
  v_capacity_available integer;
  v_daily_available integer;
  v_blocked integer;
  v_last_day text;
  v_settlement_day text;
  v_activity text;
  v_enabled boolean;
BEGIN
  SELECT enabled INTO v_enabled FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN public.settle_periodic_progression_before_economy_telemetry(p_player_id, p_tick);
  END IF;

  SELECT save.state, player.resource_reward_at, player.reward_active_until,
    player.boost_max_active, player.online
  INTO v_before_state, v_before_tick, v_reward_until, v_boost_max, v_online
  FROM public.players player
  LEFT JOIN public.player_saves save ON save.player_id = player.player_id
  WHERE player.player_id = p_player_id;

  v_result := public.settle_periodic_progression_before_economy_telemetry(p_player_id, p_tick);
  IF v_before_state IS NULL
    OR COALESCE(v_result->>'settled_through', '') = '' THEN RETURN v_result; END IF;

  BEGIN
    v_settled_through := (v_result->>'settled_through')::timestamptz;
    v_granted := GREATEST(0, COALESCE((v_result->>'chests')::integer, 0));
    v_seconds := GREATEST(0, extract(epoch FROM (
      CASE WHEN v_boost_max THEN v_settled_through ELSE LEAST(v_settled_through, v_reward_until) END
      - v_before_tick
    )));
    v_progress := GREATEST(0, COALESCE((v_before_state#>>'{boost,chestProgressSeconds}')::numeric, 0));
    v_expected := GREATEST(0, floor((v_progress + v_seconds) / 86.4)::integer);
    v_capacity_available := GREATEST(0, 500 - jsonb_array_length(COALESCE(v_before_state->'chests', '[]'::jsonb)));
    v_last_day := to_char(to_timestamp(COALESCE((v_before_state->>'lastChestReset')::numeric, 0) / 1000)
      AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
    v_settlement_day := to_char(v_settled_through AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD');
    v_daily_available := CASE WHEN v_last_day IS DISTINCT FROM v_settlement_day THEN 1000
      ELSE GREATEST(0, 1000 - COALESCE((v_before_state->>'chestsOpenedToday')::integer, 0)) END;
    v_blocked := GREATEST(0, LEAST(v_expected, v_daily_available) - v_capacity_available);
    v_activity := CASE WHEN v_boost_max THEN 'boost_max' WHEN v_online THEN 'hidden' ELSE 'offline' END;

    IF v_granted > 0 OR v_blocked > 0 THEN
      INSERT INTO public.periodic_chest_events(
        source_key, player_id, granted, blocked_capacity, activity_mode, settled_through
      ) VALUES (
        p_player_id::text || ':' || extract(epoch FROM v_settled_through)::numeric::text,
        p_player_id, v_granted, v_blocked, v_activity, v_settled_through
      ) ON CONFLICT (source_key) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Telemetry must never roll back a reward settlement.
    NULL;
  END;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.settle_periodic_progression(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_periodic_progression(uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION telemetry.collect_loot_chest_hour(p_bucket_start timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_environment text;
  v_enabled boolean;
  v_rows integer := 0;
  v_added integer;
BEGIN
  SELECT enabled, environment INTO v_enabled, v_environment
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RAISE EXCEPTION 'economy_collectors_disabled'; END IF;
  IF p_bucket_start <> date_trunc('hour', p_bucket_start) OR p_bucket_start >= date_trunc('hour', now()) THEN
    RAISE EXCEPTION 'economy_collector_requires_completed_utc_hour';
  END IF;

  WITH grouped AS (
    SELECT item.economy_balance_version AS balance_version,
      item.economy_account_level_band AS account_level_band,
      telemetry.item_level_band(item.item_level) AS item_level_band,
      item.rarity,
      CASE WHEN item.source_kind = 'store' THEN 'store_item' ELSE 'chest_item' END AS source_kind,
      count(*)::numeric AS item_count,
      count(DISTINCT item.player_id)::integer AS cohort_accounts
    FROM public.player_items item
    WHERE item.created_at >= p_bucket_start AND item.created_at < p_bucket_start + interval '1 hour'
      AND item.economy_balance_version IS NOT NULL
      AND item.source_kind IN ('standard_chest', 'boss_chest', 'store')
      AND item.rarity IN (
        'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
        'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god'
      )
    GROUP BY item.economy_balance_version, item.economy_account_level_band,
      telemetry.item_level_band(item.item_level), item.rarity,
      CASE WHEN item.source_kind = 'store' THEN 'store_item' ELSE 'chest_item' END
    HAVING count(DISTINCT item.player_id) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, item_level_band, rarity, source_kind, metric_value, cohort_accounts
  )
  SELECT 'hour', p_bucket_start AT TIME ZONE 'UTC', v_environment, balance_version,
    'loot_distribution', 'item_count', account_level_band, item_level_band, rarity,
    source_kind, item_count, cohort_accounts
  FROM grouped WHERE account_level_band IS NOT NULL AND item_level_band IS NOT NULL
  ON CONFLICT ON CONSTRAINT economy_rollups_pkey DO UPDATE SET
    metric_value = EXCLUDED.metric_value, cohort_accounts = EXCLUDED.cohort_accounts, computed_at = now();
  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_rows := v_rows + v_added;

  WITH chest_events AS (
    SELECT event.player_id, event.settled_through AS occurred_at,
      event.economy_balance_version AS balance_version,
      event.economy_account_level_band AS account_level_band,
      'timed_standard'::text AS chest_kind, event.activity_mode,
      'timed_standard_chest'::text AS source_kind, metric.metric_id, metric.metric_value
    FROM public.periodic_chest_events event
    CROSS JOIN LATERAL (VALUES
      ('granted'::text, event.granted::numeric),
      ('blocked_capacity'::text, event.blocked_capacity::numeric)
    ) metric(metric_id, metric_value)
    WHERE event.settled_through >= p_bucket_start AND event.settled_through < p_bucket_start + interval '1 hour'
      AND metric.metric_value > 0

    UNION ALL
    SELECT event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'boss', 'visible', 'boss_chest', 'granted', 1::numeric
    FROM public.boss_claim_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND event.result ? 'boss_chest'

    UNION ALL
    SELECT event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band, 'tutorial', 'visible', 'tutorial_chest', 'granted',
      (event.result#>>'{reward,tutorialChests}')::numeric
    FROM public.tutorial_quest_claim_events event
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
      AND COALESCE(event.result#>>'{reward,tutorialChests}', '') ~ '^[0-9]+$'
      AND (event.result#>>'{reward,tutorialChests}')::numeric > 0

    UNION ALL
    SELECT event.player_id, event.created_at, event.economy_balance_version,
      event.economy_account_level_band,
      CASE WHEN tutorial.idempotency_key IS NOT NULL THEN 'tutorial'
        WHEN item.source_kind = 'boss_chest' THEN 'boss' ELSE 'timed_standard' END,
      'visible', CASE WHEN tutorial.idempotency_key IS NOT NULL THEN 'tutorial_chest_open' ELSE 'chest_open' END,
      'opened', 1::numeric
    FROM public.chest_open_events event
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(event.result->'items', '[]'::jsonb)) result_item
    JOIN public.player_items item ON item.id::text = result_item->>'uid' AND item.player_id = event.player_id
    LEFT JOIN public.tutorial_chest_open_events tutorial ON tutorial.idempotency_key = event.idempotency_key
    WHERE event.created_at >= p_bucket_start AND event.created_at < p_bucket_start + interval '1 hour'
  ), grouped AS (
    SELECT balance_version, account_level_band, chest_kind, activity_mode, source_kind, metric_id,
      sum(metric_value)::numeric AS metric_value, count(DISTINCT player_id)::integer AS cohort_accounts
    FROM chest_events
    WHERE balance_version IS NOT NULL AND account_level_band IS NOT NULL
    GROUP BY balance_version, account_level_band, chest_kind, activity_mode, source_kind, metric_id
    HAVING count(DISTINCT player_id) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, activity_mode, chest_kind, source_kind, metric_value, cohort_accounts
  )
  SELECT 'hour', p_bucket_start AT TIME ZONE 'UTC', v_environment, balance_version,
    'chest_flow', metric_id, account_level_band, activity_mode, chest_kind, source_kind,
    metric_value, cohort_accounts
  FROM grouped
  ON CONFLICT ON CONSTRAINT economy_rollups_pkey DO UPDATE SET
    metric_value = EXCLUDED.metric_value, cohort_accounts = EXCLUDED.cohort_accounts, computed_at = now();
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_rows + v_added;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry.collect_economy_snapshot(p_bucket_start timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, telemetry
AS $$
DECLARE
  v_environment text;
  v_balance_version text;
  v_enabled boolean;
  v_rows integer := 0;
  v_added integer;
BEGIN
  SELECT enabled, environment, balance_version INTO v_enabled, v_environment, v_balance_version
  FROM telemetry.economy_collector_settings WHERE singleton;
  IF NOT COALESCE(v_enabled, false) THEN RAISE EXCEPTION 'economy_collectors_disabled'; END IF;
  IF p_bucket_start <> date_trunc('hour', now()) THEN
    RAISE EXCEPTION 'economy_snapshot_requires_current_utc_hour';
  END IF;

  DELETE FROM telemetry.economy_rollups
  WHERE period_kind = 'hour' AND bucket_start_utc = p_bucket_start AT TIME ZONE 'UTC'
    AND environment = v_environment AND balance_version = v_balance_version
    AND aggregate_id IN ('inventory_saturation', 'currency_balance');

  WITH samples AS (
    SELECT save.player_id,
      telemetry.account_level_band((save.state->>'accountLevel')::integer) AS account_level_band,
      GREATEST(0, (
        SELECT count(*)::integer
        FROM jsonb_array_elements(COALESCE(save.state->'inventory', '[]'::jsonb)) inventory(item)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(save.state->'ownedHeroes', '[]'::jsonb)) hero(value)
          CROSS JOIN LATERAL jsonb_each_text(COALESCE(hero.value->'equipped', '{}'::jsonb)) equipped(slot, uid)
          WHERE equipped.uid = inventory.item->>'uid'
        )
      )) AS inventory_count
    FROM public.player_saves save
    WHERE COALESCE(save.state->>'accountLevel', '') ~ '^[0-9]{1,2}$'
      AND jsonb_typeof(COALESCE(save.state->'inventory', '[]'::jsonb)) = 'array'
      AND jsonb_typeof(COALESCE(save.state->'ownedHeroes', '[]'::jsonb)) = 'array'
  ), grouped AS (
    SELECT account_level_band, telemetry.inventory_fill_band(inventory_count, 64) AS fill_band,
      count(*)::numeric AS sample_count, count(*)::integer AS cohort_accounts
    FROM samples WHERE account_level_band IS NOT NULL
    GROUP BY account_level_band, telemetry.inventory_fill_band(inventory_count, 64)
    HAVING count(*) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, inventory_fill_band, metric_value, cohort_accounts
  )
  SELECT 'hour', p_bucket_start AT TIME ZONE 'UTC', v_environment, v_balance_version,
    'inventory_saturation', 'sample_count', account_level_band, fill_band, sample_count, cohort_accounts
  FROM grouped WHERE fill_band IS NOT NULL
  ON CONFLICT ON CONSTRAINT economy_rollups_pkey DO UPDATE SET
    metric_value = EXCLUDED.metric_value, cohort_accounts = EXCLUDED.cohort_accounts, computed_at = now();
  GET DIAGNOSTICS v_added = ROW_COUNT;
  v_rows := v_rows + v_added;

  WITH balances AS (
    SELECT save.player_id,
      telemetry.account_level_band((save.state->>'accountLevel')::integer) AS account_level_band,
      currency.currency, currency.amount
    FROM public.player_saves save
    JOIN public.players player ON player.player_id = save.player_id
    CROSS JOIN LATERAL (VALUES
      ('gold'::text, CASE WHEN COALESCE(save.state->>'gold', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (save.state->>'gold')::numeric END),
      ('hero'::text, GREATEST(0, player.token_balance))
    ) currency(currency, amount)
    WHERE COALESCE(save.state->>'accountLevel', '') ~ '^[0-9]{1,2}$'
  ), grouped AS (
    SELECT account_level_band, currency, count(*)::integer AS cohort_accounts,
      count(*)::numeric AS account_count, sum(amount)::numeric AS total,
      min(amount)::numeric AS minimum, max(amount)::numeric AS maximum
    FROM balances WHERE account_level_band IS NOT NULL AND amount IS NOT NULL
    GROUP BY account_level_band, currency HAVING count(*) >= 5
  )
  INSERT INTO telemetry.economy_rollups(
    period_kind, bucket_start_utc, environment, balance_version, aggregate_id, metric_id,
    account_level_band, currency, metric_value, cohort_accounts
  )
  SELECT 'hour', p_bucket_start AT TIME ZONE 'UTC', v_environment, v_balance_version,
    'currency_balance', metric.metric_id, grouped.account_level_band, grouped.currency,
    metric.metric_value, grouped.cohort_accounts
  FROM grouped
  CROSS JOIN LATERAL (VALUES
    ('account_count'::text, grouped.account_count), ('total'::text, grouped.total),
    ('minimum'::text, grouped.minimum), ('maximum'::text, grouped.maximum)
  ) metric(metric_id, metric_value)
  ON CONFLICT ON CONSTRAINT economy_rollups_pkey DO UPDATE SET
    metric_value = EXCLUDED.metric_value, cohort_accounts = EXCLUDED.cohort_accounts, computed_at = now();
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_rows + v_added;
END;
$$;

REVOKE ALL ON FUNCTION telemetry.collect_loot_chest_hour(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION telemetry.collect_economy_snapshot(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.periodic_chest_events IS
  'Private server settlement ledger for timed chest grants/capacity blocks; created only while economy collection is enabled.';
COMMENT ON FUNCTION telemetry.collect_loot_chest_hour(timestamptz) IS
  'Private cohort-bounded loot and chest collector; scheduling is a later stage.';
COMMENT ON FUNCTION telemetry.collect_economy_snapshot(timestamptz) IS
  'Private current-hour Inventory saturation and Gold/HERO balance snapshot; scheduling is a later stage.';
