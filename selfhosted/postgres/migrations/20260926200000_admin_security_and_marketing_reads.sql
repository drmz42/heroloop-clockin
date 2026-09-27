\set ON_ERROR_STOP on

-- Two read-model corrections for the Control Center, no new data:
--
-- 1. Security → reward anomalies used every ledger row for its median and
--    outlier count. A Staging tester credit (50 000) and a deleted account's
--    balance (balance_extinguishment) are neither rewards nor spending, so they
--    are left out, the same rule the notification scan follows since
--    20260926194000_ledger_tester_credit.sql; a tester credit is never a new source.
-- 2. The marketing sheet gains quests completed and sessions played, now that
--    20260926198000_game_events_quest_session_collectors.sql records them. Like
--    every figure there, each reads not_connected until its first event.

CREATE OR REPLACE FUNCTION admin.security_summary(p_min_cohort integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_min integer := least(greatest(coalesce(p_min_cohort, 5), 5), 1000);
  v_now timestamptz := now();
  v_since timestamptz := now() - interval '7 days';
  v_risk jsonb;
  v_reasons jsonb;
  v_rewards jsonb := jsonb_build_object('state', 'not_connected');
  v_market jsonb := jsonb_build_object('state', 'not_connected');
  v_identity jsonb := jsonb_build_object('state', 'not_connected');
  v_median numeric;
  v_recipients bigint;
  v_top numeric;
  v_issued numeric;
  v_price_median numeric;
  v_collisions_7d bigint;
  v_collisions_30d bigint;
BEGIN
  SELECT jsonb_build_object(
    'watch', count(*) FILTER (WHERE level = 'watch'),
    'review', count(*) FILTER (WHERE level = 'review'),
    'hold', count(*) FILTER (WHERE level = 'hold'),
    'set_by_system', count(*) FILTER (WHERE set_by = 'system'),
    'set_by_founder', count(*) FILTER (WHERE set_by = 'founder'),
    'overdue_reviews', count(*) FILTER (WHERE review_deadline < v_now),
    'next_review_at', min(review_deadline) FILTER (WHERE review_deadline >= v_now)
  ) INTO v_risk FROM public.account_risk_levels;

  -- Why accounts are in the queue, as codes. A code is a fixed vocabulary, not
  -- free text, so it can be counted without carrying anything about a person.
  SELECT coalesce(jsonb_object_agg(code, n), '{}'::jsonb) INTO v_reasons
  FROM (
    SELECT code, count(*) AS n
    FROM public.account_risk_levels, unnest(reason_codes) AS code
    GROUP BY code
  ) r;

  -- Reward anomalies. The ledger is append-only and server-written, so the
  -- question is about shape: is issuance concentrating on very few accounts, are
  -- there entries far above the usual size, and has a source nobody recognises
  -- started issuing. Shares are withheld while too few accounts received
  -- anything, since with three recipients a share describes an individual.
  IF to_regclass('public.hero_economy_ledger') IS NOT NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)
    INTO v_median
    FROM public.hero_economy_ledger
    WHERE occurred_at >= v_since AND flow IN ('player_issuance', 'treasury_inflow') AND source_kind <> 'tester_credit';

    SELECT count(DISTINCT player_id), max(total), sum(total)
    INTO v_recipients, v_top, v_issued
    FROM (
      SELECT player_id, sum(amount) AS total
      FROM public.hero_economy_ledger
      WHERE occurred_at >= v_since AND flow = 'player_issuance' AND player_id IS NOT NULL
      GROUP BY player_id
    ) t;

    SELECT jsonb_build_object(
      'state', 'connected',
      'window_days', 7,
      'entries', count(*),
      'entries_by_flow', jsonb_build_object(
        'player_issuance', count(*) FILTER (WHERE flow = 'player_issuance'),
        'treasury_inflow', count(*) FILTER (WHERE flow = 'treasury_inflow')
      ),
      'median_amount', v_median,
      -- An entry an order of magnitude above the usual one is worth a look; it
      -- is counted, never listed, so this cannot become a way to read a payout.
      'entries_over_10x_median', count(*) FILTER (WHERE v_median IS NOT NULL AND v_median > 0 AND amount >= v_median * 10
        AND flow IN ('player_issuance', 'treasury_inflow') AND source_kind <> 'tester_credit'),
      'issuance_recipients', v_recipients,
      'top_recipient_share', CASE
        WHEN v_recipients >= v_min AND v_issued IS NOT NULL AND v_issued > 0 THEN round(v_top / v_issued, 4)
      END,
      'top_recipient_share_suppressed', coalesce(v_recipients, 0) < v_min,
      -- A source_kind whose very first entry is inside the window: either a
      -- release added it, or something is writing to the ledger unannounced.
      'new_source_kinds', (
        SELECT count(*) FROM (
          SELECT source_kind FROM public.hero_economy_ledger WHERE source_kind <> 'tester_credit'
          GROUP BY source_kind HAVING min(occurred_at) >= v_since
        ) n
      ),
      'last_entry_at', max(occurred_at)
    ) INTO v_rewards
    FROM public.hero_economy_ledger WHERE occurred_at >= v_since;
  END IF;

  -- Market anomalies. Self-dealing (the same account on both sides of a trade)
  -- is the signal worth counting here; it is reported as a count, and which
  -- accounts they were stays on Player Support.
  IF to_regclass('public.market_item_listings') IS NOT NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
    INTO v_price_median
    FROM public.market_item_listings WHERE status = 'sold' AND completed_at >= v_since;

    SELECT jsonb_build_object(
      'state', 'connected',
      'window_days', 7,
      'listed', count(*) FILTER (WHERE created_at >= v_since),
      'sold', count(*) FILTER (WHERE status = 'sold' AND completed_at >= v_since),
      'cancelled', count(*) FILTER (WHERE status = 'cancelled' AND completed_at >= v_since),
      'active_now', count(*) FILTER (WHERE status = 'active'),
      'self_trades', count(*) FILTER (WHERE status = 'sold' AND completed_at >= v_since AND buyer_id IS NOT NULL AND buyer_id = seller_id),
      'median_sold_price', v_price_median,
      'sold_over_10x_median', count(*) FILTER (
        WHERE status = 'sold' AND completed_at >= v_since
          AND v_price_median IS NOT NULL AND v_price_median > 0 AND price >= v_price_median * 10
      )
    ) INTO v_market
    FROM public.market_item_listings;
  END IF;

  -- Multi-accounting, as counts. The linking tables already refuse to bind one
  -- wallet to two accounts, so the useful figures are how many accounts hold
  -- several identities and how often a collision was refused.
  -- Its own guarded statement, not a CASE inside the query below: a reference
  -- to a missing relation is rejected when the statement is first parsed, long
  -- before any CASE could decide not to evaluate it.
  IF to_regclass('heroloop_api.identity_events') IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE created_at >= v_since),
           count(*) FILTER (WHERE created_at >= v_now - interval '30 days')
    INTO v_collisions_7d, v_collisions_30d
    FROM heroloop_api.identity_events WHERE result_code = 'subject_collision';
  END IF;

  IF to_regclass('heroloop_api.account_identities') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', 'connected',
      'accounts_with_identity', count(*),
      'accounts_multi_identity', count(*) FILTER (WHERE identities > 1),
      'accounts_multi_provider', count(*) FILTER (WHERE providers > 1),
      'subject_collisions_7d', v_collisions_7d,
      'subject_collisions_30d', v_collisions_30d
    ) INTO v_identity
    FROM (
      SELECT account_id, count(*) AS identities, count(DISTINCT provider) AS providers
      FROM heroloop_api.account_identities
      WHERE state = 'active'
      GROUP BY account_id
    ) a;
  END IF;

  RETURN jsonb_build_object(
    'version', 'security.v1',
    'as_of', v_now,
    'timezone', 'UTC',
    'min_cohort', v_min,
    'risk', v_risk,
    'risk_reason_codes', v_reasons,
    'rewards', v_rewards,
    'market', v_market,
    'multi_account', v_identity
  );
END
$function$;

CREATE OR REPLACE FUNCTION admin.game_analytics_marketing()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_have_events boolean := to_regclass('telemetry.game_events') IS NOT NULL AND to_regclass('telemetry.game_event_daily') IS NOT NULL;
  v_rolled date;
  v_figures jsonb := '[]'::jsonb;
  v_spec record;
  v_since date;
  v_all numeric;
  v_30 numeric;
  v_7 numeric;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Sign-ups (the same auth.users count Overview shows) and $HERO come from
  -- their own authoritative tables and cover the whole history; the rest come from game events and cover only the time the
  -- collector has been on.
  v_figures := v_figures || jsonb_build_array(jsonb_build_object(
    'key', 'players_registered', 'source', 'auth_users', 'state', 'connected', 'collected_since', NULL,
    'all_time', (SELECT count(*) FROM auth.users),
    'last_30_days', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '30 days'),
    'last_7_days', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '7 days')
  ));

  IF to_regclass('public.hero_economy_ledger') IS NOT NULL THEN
    v_figures := v_figures || jsonb_build_array(jsonb_build_object(
      'key', 'hero_distributed', 'source', 'hero_economy_ledger', 'state', 'connected', 'collected_since', NULL,
      'all_time', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance'),
      'last_30_days', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance' AND occurred_at >= now() - interval '30 days'),
      'last_7_days', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance' AND occurred_at >= now() - interval '7 days')
    ));
  ELSE
    v_figures := v_figures || jsonb_build_array(jsonb_build_object('key', 'hero_distributed', 'source', 'hero_economy_ledger', 'state', 'not_connected'));
  END IF;

  IF v_have_events THEN
    SELECT rolled_through INTO v_rolled FROM telemetry.game_event_rollup_state;
  END IF;

  -- key, event, measure: `events` counts rows, `qty` sums quantities (a
  -- monster_killed row carries how many died in one settlement).
  FOR v_spec IN SELECT * FROM (VALUES
    ('chests_opened', 'chest_opened', 'qty'),
    ('heroes_summoned', 'hero_summoned', 'qty'),
    ('monsters_defeated', 'monster_killed', 'qty'),
    ('bosses_defeated', 'boss_killed', 'events'),
    ('dungeons_cleared', 'dungeon_cleared', 'events'),
    ('items_enchanted', 'item_enchanted', 'events'),
    ('quests_completed', 'quest_completed', 'events'),
    ('sessions_played', 'session_started', 'events')
  ) AS spec(key, event, measure) LOOP
    IF NOT v_have_events THEN
      v_figures := v_figures || jsonb_build_array(jsonb_build_object('key', v_spec.key, 'source', 'game_events', 'event', v_spec.event, 'state', 'not_connected'));
      CONTINUE;
    END IF;
    SELECT least(
             (SELECT min(day) FROM telemetry.game_event_daily WHERE event = v_spec.event),
             (SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date FROM telemetry.game_events WHERE event = v_spec.event))
      INTO v_since;
    IF v_since IS NULL THEN
      v_figures := v_figures || jsonb_build_array(jsonb_build_object('key', v_spec.key, 'source', 'game_events', 'event', v_spec.event, 'state', 'not_connected'));
      CONTINUE;
    END IF;
    WITH combined AS (
      SELECT day, CASE WHEN v_spec.measure = 'qty' THEN qty ELSE events END AS amount
      FROM telemetry.game_event_daily WHERE event = v_spec.event AND day <= coalesce(v_rolled, '-infinity'::date)
      UNION ALL
      SELECT (occurred_at AT TIME ZONE 'UTC')::date, CASE WHEN v_spec.measure = 'qty' THEN qty ELSE 1 END
      FROM telemetry.game_events
      WHERE event = v_spec.event AND occurred_at >= (coalesce(v_rolled + 1, '-infinity'::date))::timestamp AT TIME ZONE 'UTC'
    )
    SELECT coalesce(sum(amount), 0),
           coalesce(sum(amount) FILTER (WHERE day > v_today - 30), 0),
           coalesce(sum(amount) FILTER (WHERE day > v_today - 7), 0)
      INTO v_all, v_30, v_7
    FROM combined;
    v_figures := v_figures || jsonb_build_array(jsonb_build_object(
      'key', v_spec.key, 'source', 'game_events', 'event', v_spec.event, 'state', 'connected',
      'collected_since', v_since, 'all_time', v_all, 'last_30_days', v_30, 'last_7_days', v_7
    ));
  END LOOP;

  RETURN jsonb_build_object('version', 'marketing-sheet.v1', 'generated_at', now(), 'figures', v_figures);
END
$function$;

REVOKE ALL ON FUNCTION admin.security_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.security_summary(integer) TO heroloop_admin;
REVOKE ALL ON FUNCTION admin.game_analytics_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.game_analytics_marketing() TO heroloop_admin;
