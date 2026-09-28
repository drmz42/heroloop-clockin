\set ON_ERROR_STOP on

-- Control Center Payments: $HERO Shop bundles (HL-TASK-20260927234716-87F1EA).
--
-- Adds shop_bundle_purchase_events next to the boosts with the same rules: a
-- grant receipt (bundle, spent amount and resource balance recorded by the
-- atomic settlement) and token-spend/ledger parity under the `shop-bundle`
-- treasury kind. The Founder decided on 2026-09-28 that in-game $HERO sales
-- are final, so refunds report the policy `final_sale` instead of a
-- settlement source. Aggregates only.

CREATE OR REPLACE FUNCTION admin.payments_summary(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 366);
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366));
  v_store jsonb := jsonb_build_object('state', 'not_connected');
  v_boosts jsonb := jsonb_build_object('state', 'not_connected');
  v_bundles jsonb := jsonb_build_object('state', 'not_connected');
BEGIN
  IF to_regclass('public.store_purchase_events') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'purchases', count(*),
      'buyers', count(DISTINCT player_id),
      'gold_spent', coalesce(sum(CASE WHEN coalesce(result->>'price', '') ~ '^[0-9]+$' THEN (result->>'price')::numeric END), 0),
      'grant_receipt_gaps', count(*) FILTER (WHERE jsonb_typeof(result->'item') IS DISTINCT FROM 'object'
        OR jsonb_typeof(result->'inventory') IS DISTINCT FROM 'array'
        OR NOT (result->'inventory' @> jsonb_build_array(result->'item'))
        OR coalesce(result->>'price', '') !~ '^[0-9]+$'),
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
      'grant_receipt_gaps', count(*) FILTER (WHERE b.result->>'plan' IS DISTINCT FROM b.plan
        OR b.result->'spent' IS DISTINCT FROM to_jsonb(b.token_cost)
        OR b.result->'boost_expires_at' IS DISTINCT FROM to_jsonb(b.boost_expires_at)),
      'by_plan', coalesce((
        SELECT jsonb_object_agg(plan, jsonb_build_object('purchases', n, 'tokens', t))
        FROM (SELECT plan, count(*) AS n, sum(token_cost) AS t FROM public.reward_boost_purchase_events
              WHERE created_at >= v_since GROUP BY plan) p), '{}'::jsonb),
      -- The shared key alone is insufficient: a foreign player, unrelated
      -- action or non-treasury ledger row must remain a settlement gap.
      'unreconciled', count(*) FILTER (WHERE s.idempotency_key IS NULL OR l.id IS NULL
        OR s.player_id IS DISTINCT FROM b.player_id
        OR s.action_kind IS DISTINCT FROM 'reward-boost-' || b.plan
        OR s.amount IS DISTINCT FROM b.token_cost
        OR l.player_id IS DISTINCT FROM b.player_id
        OR l.source_kind IS DISTINCT FROM 'reward-boost-' || b.plan
        OR l.flow IS DISTINCT FROM 'treasury_inflow'
        OR l.amount IS DISTINCT FROM b.token_cost),
      'last_at', max(b.created_at)
    ) INTO v_boosts
    FROM public.reward_boost_purchase_events b
    LEFT JOIN public.token_spend_events s ON s.idempotency_key = b.idempotency_key
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'token_spend:' || b.idempotency_key
    WHERE b.created_at >= v_since;
  END IF;

  IF to_regclass('public.shop_bundle_purchase_events') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'purchases', count(*),
      'buyers', count(DISTINCT b.player_id),
      'tokens_spent', coalesce(sum(b.token_cost), 0),
      'catalogue_usd', round(coalesce(sum(b.catalogue_usd_cents), 0) / 100.0, 2),
      'grant_receipt_gaps', count(*) FILTER (WHERE b.result->>'bundle' IS DISTINCT FROM b.bundle
        OR b.result->'spent' IS DISTINCT FROM to_jsonb(b.token_cost)
        OR b.result->'quantity' IS DISTINCT FROM to_jsonb(b.quantity)
        OR coalesce(b.result->>'resource_balance', '') !~ '^[0-9]+$'
        OR (b.result->>'resource_balance')::numeric < b.quantity),
      'by_bundle', coalesce((
        SELECT jsonb_object_agg(bundle, jsonb_build_object('purchases', n, 'tokens', t))
        FROM (SELECT bundle, count(*) AS n, sum(token_cost) AS t FROM public.shop_bundle_purchase_events
              WHERE created_at >= v_since GROUP BY bundle) p), '{}'::jsonb),
      'unreconciled', count(*) FILTER (WHERE s.idempotency_key IS NULL OR l.id IS NULL
        OR s.player_id IS DISTINCT FROM b.player_id
        OR s.action_kind IS DISTINCT FROM 'shop-bundle'
        OR s.amount IS DISTINCT FROM b.token_cost
        OR l.player_id IS DISTINCT FROM b.player_id
        OR l.source_kind IS DISTINCT FROM 'shop-bundle'
        OR l.flow IS DISTINCT FROM 'treasury_inflow'
        OR l.amount IS DISTINCT FROM b.token_cost),
      'last_at', max(b.created_at)
    ) INTO v_bundles
    FROM public.shop_bundle_purchase_events b
    LEFT JOIN public.token_spend_events s ON s.idempotency_key = b.idempotency_key
    LEFT JOIN public.hero_economy_ledger l ON l.source_key = 'token_spend:' || b.idempotency_key
    WHERE b.created_at >= v_since;
  END IF;

  RETURN jsonb_build_object(
    'version', 'payments.v3',
    'as_of', now(),
    'window_days', v_days,
    'store_gold', v_store,
    'reward_boosts', v_boosts,
    'shop_bundles', v_bundles,
    -- Wallet authentication alone does not verify a payment or grant goods.
    'solana_sol', jsonb_build_object('state', 'not_connected'),
    'hero_onchain', jsonb_build_object('state', 'not_connected'),
    'real_money_payments', jsonb_build_object('state', 'not_connected'),
    -- In-game $HERO sales are final (Founder, 2026-09-28): no refund path exists.
    'refunds', jsonb_build_object('state', 'not_offered', 'policy', 'final_sale'),
    'disputes', jsonb_build_object('state', 'not_connected')
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.payments_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.payments_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.payments_summary(integer) IS
  'Read-only purchases over a clamped window: shop Gold, $HERO boosts and $HERO Shop bundles with grant receipt checks and token-spend/ledger parity; refunds are not offered (final sale); SOL, on-chain HERO and disputes not_connected. Aggregates only.';
