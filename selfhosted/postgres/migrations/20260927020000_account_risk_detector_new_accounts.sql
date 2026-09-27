\set ON_ERROR_STOP on

-- Account risk detector, second pass (Founder asked the agent to decide,
-- 2026-09-27). A new account has no own history to compare with, so its income
-- spike needs 50x the cohort median instead of 20x; an established account
-- keeps 20x the median and 5x its own 7-day average. Dry passes are now logged,
-- so a new environment can run count-only for a week before it may act.

DROP FUNCTION IF EXISTS public.account_risk_detector_signals(timestamptz, integer, numeric, numeric, numeric, integer, numeric, integer, integer);

-- One row per (player, signal) that fires on evidence newer than p_since for
-- that player. Read-only; the pass below decides what to do with it.
CREATE OR REPLACE FUNCTION public.account_risk_detector_signals(
  p_now timestamptz DEFAULT now(),
  p_min_cohort integer DEFAULT 20,
  p_income_multiple numeric DEFAULT 20,
  p_income_self_multiple numeric DEFAULT 5,
  p_market_multiple numeric DEFAULT 5,
  p_market_min_buyers integer DEFAULT 3,
  p_pair_multiple numeric DEFAULT 3,
  p_pair_min_trades integer DEFAULT 3,
  p_min_rarity_sales integer DEFAULT 5,
  p_new_account_multiple numeric DEFAULT 50
)
RETURNS TABLE(player_id uuid, reason_code text, metric text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH founder_cut AS (
    SELECT e.player_id, max(e.created_at) AS cut_at
    FROM public.account_risk_events e WHERE e.actor = 'founder' GROUP BY e.player_id
  ),
  since AS (
    -- Evidence must be newer than the Founder's last decision and, for an
    -- account already at Watch, newer than that Watch.
    SELECT p.player_id,
           greatest(coalesce(f.cut_at, '-infinity'::timestamptz),
                    CASE WHEN r.level = 'watch' THEN r.updated_at ELSE '-infinity'::timestamptz END) AS since_at,
           coalesce(r.level, 'normal') AS level
    FROM public.players p
    LEFT JOIN founder_cut f ON f.player_id = p.player_id
    LEFT JOIN public.account_risk_levels r ON r.player_id = p.player_id
  ),
  -- Income spike: 24-hour $HERO issuance at least p_income_multiple times the
  -- cohort median and at least p_income_self_multiple times its own daily
  -- average of the previous 7 days; an account with under three earlier days
  -- needs p_new_account_multiple times the median instead.
  income AS (
    SELECT l.player_id, sum(l.amount) AS day_sum
    FROM public.hero_economy_ledger l
    JOIN since s ON s.player_id = l.player_id
    WHERE l.flow = 'player_issuance' AND l.occurred_at > p_now - interval '24 hours'
      AND l.occurred_at > s.since_at
    GROUP BY l.player_id
  ),
  cohort AS (
    SELECT count(*) AS earners, percentile_cont(0.5) WITHIN GROUP (ORDER BY day_sum) AS median
    FROM (SELECT l.player_id, sum(l.amount) AS day_sum FROM public.hero_economy_ledger l
          WHERE l.flow = 'player_issuance' AND l.occurred_at > p_now - interval '24 hours'
          GROUP BY l.player_id) x
  ),
  history AS (
    SELECT l.player_id,
           count(DISTINCT date_trunc('day', l.occurred_at)) AS days,
           sum(l.amount) / 7 AS daily_avg
    FROM public.hero_economy_ledger l
    WHERE l.flow = 'player_issuance'
      AND l.occurred_at > p_now - interval '8 days' AND l.occurred_at <= p_now - interval '24 hours'
    GROUP BY l.player_id
  ),
  income_hits AS (
    SELECT i.player_id, 'hero_income_spike'::text AS reason_code,
           format('day=%s median=%s', round(i.day_sum, 2), round(c.median::numeric, 2)) AS metric
    FROM income i CROSS JOIN cohort c
    LEFT JOIN history h ON h.player_id = i.player_id
    WHERE c.earners >= p_min_cohort AND c.median > 0
      -- An account with under three earlier days has no history to compare
      -- with, so it must stand out much further from the cohort.
      AND (
        (coalesce(h.days, 0) < 3 AND i.day_sum >= c.median::numeric * p_new_account_multiple)
        OR (h.days >= 3 AND i.day_sum >= c.median::numeric * p_income_multiple
            AND i.day_sum >= h.daily_avg * p_income_self_multiple)
      )
  ),
  -- Market prices are compared with the 30-day median sale price of the same
  -- rarity; a rarity with fewer than p_min_rarity_sales sales has no median.
  sold AS (
    SELECT m.seller_id, m.buyer_id, m.price, m.completed_at, i.rarity
    FROM public.market_item_listings m
    JOIN public.player_items i ON i.id = m.item_id
    WHERE m.status = 'sold' AND m.buyer_id IS NOT NULL
      AND m.completed_at > p_now - interval '30 days'
  ),
  rarity_median AS (
    SELECT rarity, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median
    FROM sold GROUP BY rarity HAVING count(*) >= p_min_rarity_sales
  ),
  priced AS (
    SELECT s.*, s.price / nullif(r.median, 0) AS multiple
    FROM sold s JOIN rarity_median r ON r.rarity = s.rarity
  ),
  -- Value funnel: one seller paid far above the median by several buyers in a day.
  funnel_hits AS (
    SELECT p.seller_id AS player_id, 'market_value_funnel'::text AS reason_code,
           format('buyers=%s', count(DISTINCT p.buyer_id)) AS metric
    FROM priced p JOIN since s ON s.player_id = p.seller_id
    WHERE p.completed_at > p_now - interval '24 hours' AND p.completed_at > s.since_at
      AND p.multiple >= p_market_multiple
    GROUP BY p.seller_id
    HAVING count(DISTINCT p.buyer_id) >= p_market_min_buyers
  ),
  -- Paired trading: the same two accounts trade overpriced items with each
  -- other repeatedly in a week, in either direction. Both sides are flagged.
  pair_trades AS (
    SELECT least(p.seller_id, p.buyer_id) AS a, greatest(p.seller_id, p.buyer_id) AS b, p.completed_at
    FROM priced p
    WHERE p.completed_at > p_now - interval '7 days' AND p.multiple >= p_pair_multiple
      AND p.seller_id <> p.buyer_id
  ),
  pair_hits AS (
    SELECT side.player_id, 'paired_trading'::text AS reason_code, format('trades=%s', count(*)) AS metric
    FROM pair_trades t
    CROSS JOIN LATERAL (VALUES (t.a), (t.b)) AS side(player_id)
    JOIN since s ON s.player_id = side.player_id
    WHERE t.completed_at > s.since_at
    GROUP BY side.player_id, t.a, t.b
    HAVING count(*) >= p_pair_min_trades
  ),
  -- Combat timers: the server allows one pending wave and completes it no
  -- earlier than available_at, so either of these is a server-side exploit.
  combat_hits AS (
    SELECT e.player_id, 'combat_timer_violation'::text AS reason_code,
           format('early=%s overlap=%s', count(*) FILTER (WHERE e.completed_at < e.available_at),
                  count(*) FILTER (WHERE e.overlaps)) AS metric
    FROM (
      SELECT n.player_id, n.completed_at, n.available_at, n.started_at,
             n.started_at < lag(n.completed_at) OVER (PARTITION BY n.player_id ORDER BY n.started_at) AS overlaps
      FROM public.normal_combat_events n
      WHERE n.started_at > p_now - interval '24 hours' AND n.completed_at IS NOT NULL
    ) e
    JOIN since s ON s.player_id = e.player_id
    WHERE e.started_at > s.since_at
    GROUP BY e.player_id
    HAVING count(*) FILTER (WHERE e.completed_at < e.available_at OR e.overlaps) > 0
  )
  SELECT DISTINCT ON (h.player_id, h.reason_code) h.player_id, h.reason_code, h.metric
  FROM (
    SELECT * FROM income_hits UNION ALL SELECT * FROM funnel_hits
    UNION ALL SELECT * FROM pair_hits UNION ALL SELECT * FROM combat_hits
  ) h
  JOIN since s ON s.player_id = h.player_id
  WHERE s.level IN ('normal', 'watch')
  ORDER BY h.player_id, h.reason_code
$$;

CREATE OR REPLACE FUNCTION public.account_risk_detector_run(
  p_apply boolean DEFAULT false,
  p_max_reviews integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
  v_decisions jsonb := '[]'::jsonb;
  v_reviews integer := 0;
  v_watches integer := 0;
  v_fuse boolean := false;
  v_signals jsonb;
  v_codes text;
  v_summary jsonb;
  v_notify boolean := to_regprocedure('admin.notification_record(text,text,text,text,text,numeric)') IS NOT NULL;
BEGIN
  -- One pass at a time; a second caller waits instead of double-escalating.
  PERFORM pg_advisory_xact_lock(hashtextextended('account_risk_detector', 0));

  SELECT coalesce(jsonb_object_agg(reason_code, n), '{}'::jsonb) INTO v_signals
  FROM (SELECT reason_code, count(*) AS n FROM public.account_risk_detector_signals() GROUP BY reason_code) x;

  FOR v_row IN
    SELECT s.player_id, coalesce(r.level, 'normal') AS level,
           array_agg(s.reason_code ORDER BY s.reason_code) AS codes,
           string_agg(s.reason_code || ' ' || s.metric, '; ' ORDER BY s.reason_code) AS note,
           coalesce(r.reason_codes, '{}') AS old_codes
    FROM public.account_risk_detector_signals() s
    LEFT JOIN public.account_risk_levels r ON r.player_id = s.player_id
    GROUP BY s.player_id, r.level, r.reason_codes
  LOOP
    IF v_row.level = 'watch' OR cardinality(v_row.codes) >= 2 THEN
      v_reviews := v_reviews + 1;
      v_decisions := v_decisions || jsonb_build_object('player_id', v_row.player_id, 'level', 'review',
        'codes', to_jsonb(ARRAY(SELECT DISTINCT c FROM unnest(v_row.old_codes || v_row.codes) c ORDER BY c)), 'note', v_row.note);
    ELSE
      v_watches := v_watches + 1;
      v_decisions := v_decisions || jsonb_build_object('player_id', v_row.player_id, 'level', 'watch',
        'codes', to_jsonb(v_row.codes), 'note', v_row.note);
    END IF;
  END LOOP;

  v_fuse := v_reviews > p_max_reviews;

  IF p_apply THEN
    FOR v_row IN SELECT * FROM jsonb_to_recordset(v_decisions) AS d(player_id uuid, level text, codes text[], note text) LOOP
      -- The fuse keeps every account where it was when too many would be frozen
      -- at once; new accounts still get the invisible Watch.
      CONTINUE WHEN v_fuse AND v_row.level = 'review';
      PERFORM public.set_account_risk_level(v_row.player_id, v_row.level, 'system', v_row.codes,
        left('detector: ' || v_row.note, 500), NULL);
    END LOOP;

    IF v_notify AND v_fuse THEN
      PERFORM admin.notification_record('approval_queue', 'critical', 'approval_queue:detector_fuse',
        'Risk detector stopped',
        format('The detector wanted to set Review on %s accounts at once (limit %s) and set none. Check the signals before enabling it again.', v_reviews, p_max_reviews),
        6);
    ELSIF v_notify AND v_reviews > 0 THEN
      SELECT string_agg(DISTINCT c, ', ' ORDER BY c) INTO v_codes
      FROM jsonb_to_recordset(v_decisions) AS d(level text, codes text[]), unnest(d.codes) c WHERE d.level = 'review';
      PERFORM admin.notification_record('approval_queue', 'warning',
        'approval_queue:auto_review:' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'),
        'Detector set Review',
        left(format('Accounts under review: %s (signals: %s). Their tokens and market access are frozen. Decide in Players within 1 hour.', v_reviews, v_codes), 400),
        0.25);
    END IF;
  END IF;

  v_summary := jsonb_build_object('signals', v_signals, 'watch', v_watches, 'review', v_reviews,
    'fuse', v_fuse, 'applied', p_apply);
  -- Dry passes are logged too: a week of them calibrates the thresholds before
  -- the detector is allowed to act on a new environment.
  INSERT INTO public.account_risk_detector_runs(applied, summary) VALUES (p_apply, v_summary);
  RETURN v_summary;
END
$$;

REVOKE ALL ON FUNCTION public.account_risk_detector_signals(timestamptz, integer, numeric, numeric, numeric, integer, numeric, integer, integer, numeric)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.account_risk_detector_run(boolean, integer) FROM PUBLIC, anon, authenticated, service_role;
