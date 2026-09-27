\set ON_ERROR_STOP on

-- $HERO ledger: Staging tester credits are issuance too
-- (config/economy/hero-ledger-reconciliation.v1.json, currentCoverageBlockers
-- "tester_credit_tokens").
--
-- The tester "+50 000 $HERO" button raised pending_tokens through
-- credit_token_distribution without a distribution_log row, so the ledger never
-- saw it and the global player total drifted by 50 000 on every press. It now
-- books one player_issuance / tester_credit row in the same transaction.
--
-- The row carries no player id, like the mining pool's: per-player readers (the
-- risk detector's income-spike signal, the hourly settlement collector) must not
-- read a tester's own button as that player's earnings. For the same reason the
-- ledger-outlier alert and its median now look at accruals and spending only and
-- skip tester credits, and a tester credit is never reported as a new source.
-- The API serves this function only when TESTER_CONTROLS_ENABLED is set, which
-- Production never sets.

CREATE OR REPLACE FUNCTION heroloop_api.tester_credit_tokens(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_credited boolean;
  v_result jsonb;
BEGIN
  v_credited := public.credit_token_distribution(p_player_id, 50000);
  IF v_credited IS DISTINCT FROM true THEN RAISE EXCEPTION 'tester_credit_failed'; END IF;
  INSERT INTO public.hero_economy_ledger(flow, source_kind, source_key, player_id, amount, occurred_at)
  VALUES ('player_issuance', 'tester_credit', 'tester_credit:' || gen_random_uuid(), NULL, 50000, now());
  SELECT jsonb_build_object(
    'claimed', claim_result.claimed,
    'pending', claim_result.pending,
    'total_claimed', claim_result.total_claimed,
    'token_balance', claim_result.token_balance
  ) INTO v_result
  FROM public.claim_player_tokens(p_player_id) claim_result;
  IF v_result IS NULL THEN RAISE EXCEPTION 'tester_claim_failed'; END IF;
  RETURN v_result;
END
$function$;

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
    -- Accruals and spending only: a tester credit is a fixed Staging grant and
    -- an extinguishment is a deleted account's balance, neither of them an
    -- unusually large reward.
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) INTO v_median
    FROM public.hero_economy_ledger
    WHERE occurred_at >= now() - interval '7 days'
      AND flow IN ('player_issuance', 'treasury_inflow') AND source_kind <> 'tester_credit';

    SELECT count(*) FILTER (WHERE v_median IS NOT NULL AND v_median > 0 AND amount >= v_median * v_multiple)
      INTO v_outliers
    FROM public.hero_economy_ledger
    WHERE occurred_at >= now() - interval '7 days'
      AND flow IN ('player_issuance', 'treasury_inflow') AND source_kind <> 'tester_credit';

    SELECT count(*) INTO v_new_sources FROM (
      SELECT source_kind FROM public.hero_economy_ledger
      WHERE source_kind <> 'tester_credit'
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
