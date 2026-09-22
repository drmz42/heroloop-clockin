\set ON_ERROR_STOP on

-- The whole Market is frozen at Review/Hold (Gold can be exchanged for tokens
-- there). A frozen seller's listings cannot be bought either, without revealing why.
CREATE OR REPLACE FUNCTION heroloop_api.market_list_item(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_item_id uuid,
  p_price bigint
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.assert_account_value_allowed(p_player_id);
  RETURN public.settle_market_list(p_player_id, p_idempotency_key, p_item_id, p_price);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_cancel_listing(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.assert_account_value_allowed(p_player_id);
  RETURN public.settle_market_cancel(p_player_id, p_idempotency_key, p_listing_id);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_buy_listing(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_seller_id uuid;
BEGIN
  PERFORM public.assert_account_value_allowed(p_player_id);
  SELECT seller_id INTO v_seller_id FROM public.market_item_listings WHERE id = p_listing_id;
  IF v_seller_id IS NOT NULL AND public.account_risk_level(v_seller_id) IN ('review', 'hold') THEN
    RAISE EXCEPTION 'market_listing_unavailable';
  END IF;
  RETURN public.settle_market_buy(p_player_id, p_idempotency_key, p_listing_id);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_seed_test_stock(
  p_player_id uuid,
  p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM public.assert_account_value_allowed(p_player_id);
  RETURN public.seed_market_test_stock(p_player_id, p_idempotency_key);
END
$function$;

-- Player-visible restriction: only the banner kind. Watch is never exposed.
CREATE FUNCTION heroloop_api.account_restriction(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'banner',
    CASE public.account_risk_level(p_player_id)
      WHEN 'review' THEN 'review'
      WHEN 'hold' THEN 'hold'
      ELSE NULL
    END
  )
$function$;

REVOKE ALL ON FUNCTION heroloop_api.account_restriction(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.account_restriction(uuid) TO heroloop_api;
