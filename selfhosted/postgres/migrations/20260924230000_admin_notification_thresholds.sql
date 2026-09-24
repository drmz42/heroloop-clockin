\set ON_ERROR_STOP on

-- The ledger-outlier alert was too eager to be useful.
--
-- On Staging, ten times the seven-day median means about 70 tokens against a
-- median of 7, which matched 75 of 20 000 entries: an alert that fires on
-- ordinary rewards trains the Founder to ignore the channel. The multiple is now
-- fifty, and it is a parameter rather than a constant, so the threshold can be
-- tuned from the caller without another migration and the contract test can
-- still drive the rule with a smaller fixture.
--
-- Nothing else about the scan changes: the same sources, the same cooldowns, the
-- same aggregates, still no row that can name a player.

DROP FUNCTION IF EXISTS admin.notification_scan();

CREATE OR REPLACE FUNCTION admin.notification_scan(p_outlier_multiple numeric DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_multiple numeric := least(greatest(coalesce(p_outlier_multiple, 50), 2), 1000);
  v_results jsonb := '[]'::jsonb;
  v_recorded integer := 0;
  v_suppressed integer := 0;
  v_checked text[] := ARRAY[]::text[];
  v_overdue bigint := 0;
  v_hold bigint := 0;
  v_median numeric;
  v_outliers bigint := 0;
  v_new_sources bigint := 0;
  v_self_trades bigint := 0;
BEGIN
  IF to_regclass('public.account_risk_levels') IS NOT NULL THEN
    v_checked := v_checked || 'approval_queue'::text;
    SELECT count(*) FILTER (WHERE review_deadline < now()),
           count(*) FILTER (WHERE level = 'hold')
      INTO v_overdue, v_hold
    FROM public.account_risk_levels;

    IF v_overdue > 0 THEN
      v_results := v_results || admin.notification_record('approval_queue', 'warning', 'approval_queue:overdue_reviews',
        'Overdue risk reviews',
        format('Review deadline passed for %s accounts. The review stays in place: decide in Players.', v_overdue),
        24);
    END IF;
    IF v_hold > 0 THEN
      v_results := v_results || admin.notification_record('approval_queue', 'warning', 'approval_queue:hold_accounts',
        'Accounts on hold',
        format('%s accounts are on hold: their tokens and withdrawals are stopped until a decision.', v_hold),
        168);
    END IF;
  END IF;

  IF to_regclass('public.hero_economy_ledger') IS NOT NULL THEN
    v_checked := v_checked || 'economy_anomalies'::text;
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) INTO v_median
    FROM public.hero_economy_ledger WHERE occurred_at >= now() - interval '7 days';

    SELECT count(*) FILTER (WHERE v_median IS NOT NULL AND v_median > 0 AND amount >= v_median * v_multiple)
      INTO v_outliers
    FROM public.hero_economy_ledger WHERE occurred_at >= now() - interval '7 days';

    SELECT count(*) INTO v_new_sources FROM (
      SELECT source_kind FROM public.hero_economy_ledger
      GROUP BY source_kind HAVING min(occurred_at) >= now() - interval '7 days'
    ) fresh;

    IF v_outliers > 0 THEN
      v_results := v_results || admin.notification_record('economy_anomalies', 'warning', 'economy:ledger_outliers',
        'Large ledger credits',
        format('%s entries in 7 days at least %s times above normal. Amounts and recipients stay under Economy.', v_outliers, round(v_multiple)),
        24);
    END IF;
    IF v_new_sources > 0 THEN
      v_results := v_results || admin.notification_record('economy_anomalies', 'warning', 'economy:new_ledger_source',
        'New credit source',
        format('%s new sources appeared in the ledger: either a new release or something undeclared is writing to the ledger.', v_new_sources),
        24);
    END IF;
  END IF;

  IF to_regclass('public.market_item_listings') IS NOT NULL THEN
    SELECT count(*) INTO v_self_trades
    FROM public.market_item_listings
    WHERE status = 'sold' AND completed_at >= now() - interval '7 days'
      AND buyer_id IS NOT NULL AND buyer_id = seller_id;

    IF v_self_trades > 0 THEN
      v_results := v_results || admin.notification_record('economy_anomalies', 'critical', 'economy:market_self_trades',
        'Self-trades on the Market',
        format('%s sales in 7 days where buyer and seller are the same account. This moves gold around rather than trading.', v_self_trades),
        24);
    END IF;
  END IF;

  SELECT count(*) FILTER (WHERE (entry->>'recorded')::boolean),
         count(*) FILTER (WHERE NOT (entry->>'recorded')::boolean)
    INTO v_recorded, v_suppressed
  FROM jsonb_array_elements(v_results) AS entries(entry);

  INSERT INTO admin.notification_runs(kind, recorded, suppressed) VALUES ('database', v_recorded, v_suppressed);

  RETURN jsonb_build_object(
    'kind', 'database',
    'recorded', v_recorded,
    'suppressed', v_suppressed,
    'checked', to_jsonb(v_checked),
    'outlier_multiple', v_multiple,
    'approval_queue', jsonb_build_object('overdue_reviews', v_overdue, 'hold_accounts', v_hold),
    'economy', jsonb_build_object('ledger_outliers', v_outliers, 'new_sources', v_new_sources, 'market_self_trades', v_self_trades)
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_scan(numeric) FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_scan(numeric) IS
  'Evaluates the database-side notification sources (approval queue, economy anomalies) and records what it finds. The ledger-outlier multiple defaults to fifty times the seven-day median, high enough that ordinary rewards do not alert; aggregates only, no row can name a player.';
