\set ON_ERROR_STOP on

-- Control Center Payments, first read-only slice (HL-TASK-20260924112815-C6FA06,
-- docs/game/founder-control-center-v2-tz.md, Business Control → Payments).
--
-- What the game can sell today, over a clamped window: rotating-shop items for
-- Gold (store_purchase_events) and reward boosts for $HERO
-- (reward_boost_purchase_events, catalogue price in USD cents). The boost
-- purchase is reconciled against the ledger: every purchase must have its
-- token spend and its ledger row with the same amount, the same rule as the
-- $HERO reconciliation. There is no real-money or Solana payment flow in the
-- game, so payments, refunds and disputes report not_connected rather than
-- zero. Aggregates only: no player, no item id, no quote id.

CREATE OR REPLACE FUNCTION admin.payments_summary(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 366);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366));
  v_store jsonb := jsonb_build_object('state', 'not_connected');
  v_boosts jsonb := jsonb_build_object('state', 'not_connected');
BEGIN
  IF to_regclass('public.store_purchase_events') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'purchases', count(*),
      'buyers', count(DISTINCT player_id),
      'gold_spent', coalesce(sum(CASE WHEN coalesce(result->>'price', '') ~ '^[0-9]+$' THEN (result->>'price')::numeric END), 0),
      'last_at', max(created_at)
    ) INTO v_store
    FROM public.store_purchase_events WHERE created_at >= v_since;
  END IF;

  IF to_regclass('public.reward_boost_purchase_events') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'purchases', count(*),
      'buyers', count(DISTINCT b.player_id),
      'tokens_spent', coalesce(sum(b.token_cost), 0),
      'catalogue_usd', round(coalesce(sum(b.catalogue_usd_cents), 0) / 100.0, 2),
      'by_plan', coalesce((
        SELECT jsonb_object_agg(plan, jsonb_build_object('purchases', n, 'tokens', t))
        FROM (SELECT plan, count(*) AS n, sum(token_cost) AS t FROM public.reward_boost_purchase_events
              WHERE created_at >= v_since GROUP BY plan) p), '{}'::jsonb),
      -- A purchase without its token spend or its ledger row, or with another
      -- amount, is a settlement gap; zero is the only acceptable value.
      'unreconciled', count(*) FILTER (WHERE s.idempotency_key IS NULL OR l.id IS NULL OR l.amount <> b.token_cost OR s.amount <> b.token_cost),
      'last_at', max(b.created_at)
    ) INTO v_boosts
    FROM public.reward_boost_purchase_events b
    LEFT JOIN public.token_spend_events s ON s.idempotency_key = b.idempotency_key
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'token_spend:' || b.idempotency_key
    WHERE b.created_at >= v_since;
  END IF;

  RETURN jsonb_build_object(
    'version', 'payments.v1',
    'as_of', now(),
    'window_days', v_days,
    'store_gold', v_store,
    'reward_boosts', v_boosts,
    -- No real-money or Solana payment exists in the game yet.
    'real_money_payments', jsonb_build_object('state', 'not_connected'),
    'refunds', jsonb_build_object('state', 'not_connected'),
    'disputes', jsonb_build_object('state', 'not_connected')
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.payments_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.payments_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.payments_summary(integer) IS
  'Read-only purchases over a clamped window: shop items for Gold, reward boosts for $HERO with their ledger reconciliation; real-money payments, refunds and disputes not_connected. Aggregates only.';
