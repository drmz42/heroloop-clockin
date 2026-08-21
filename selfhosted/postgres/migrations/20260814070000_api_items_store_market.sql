\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION heroloop_api.chest_open(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_count integer
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_chest_open(p_player_id, p_idempotency_key, p_count)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.item_mutate(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_action_kind text,
  p_item_ids jsonb,
  p_desired_locked boolean
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_item_ids uuid[];
BEGIN
  IF jsonb_typeof(p_item_ids) <> 'array' THEN RAISE EXCEPTION 'invalid_item_count'; END IF;
  SELECT array_agg(value::uuid ORDER BY ordinality) INTO v_item_ids
  FROM jsonb_array_elements_text(p_item_ids) WITH ORDINALITY AS item(value, ordinality);
  RETURN public.settle_item_mutation(
    p_player_id, p_idempotency_key, p_action_kind, v_item_ids, p_desired_locked
  );
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.item_equip(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_assignments jsonb
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_item_equipment(p_player_id, p_idempotency_key, p_assignments)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.item_upgrade(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_action_kind text,
  p_item_id uuid,
  p_use_charm boolean
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_item_upgrade(
    p_player_id, p_idempotency_key, p_action_kind, p_item_id, p_use_charm
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.store_snapshot(p_player_id uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.store_snapshot(p_player_id)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.store_buy_item(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_slot_index integer,
  p_refresh_at bigint
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_store_purchase(
    p_player_id, p_idempotency_key, p_slot_index, p_refresh_at
  )
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_snapshot(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.market_snapshot(p_player_id)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_list_item(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_item_id uuid,
  p_price bigint
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_market_list(p_player_id, p_idempotency_key, p_item_id, p_price)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_cancel_listing(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_market_cancel(p_player_id, p_idempotency_key, p_listing_id)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_buy_listing(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.settle_market_buy(p_player_id, p_idempotency_key, p_listing_id)
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.market_seed_test_stock(
  p_player_id uuid,
  p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT public.seed_market_test_stock(p_player_id, p_idempotency_key)
$function$;

REVOKE ALL ON FUNCTION heroloop_api.chest_open(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.item_mutate(uuid, uuid, text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.item_equip(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.item_upgrade(uuid, uuid, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.store_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.store_buy_item(uuid, uuid, integer, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.market_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.market_list_item(uuid, uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.market_cancel_listing(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.market_buy_listing(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.market_seed_test_stock(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION heroloop_api.chest_open(uuid, uuid, integer) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.item_mutate(uuid, uuid, text, jsonb, boolean) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.item_equip(uuid, uuid, jsonb) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.item_upgrade(uuid, uuid, text, uuid, boolean) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.store_snapshot(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.store_buy_item(uuid, uuid, integer, bigint) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.market_snapshot(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.market_list_item(uuid, uuid, uuid, bigint) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.market_cancel_listing(uuid, uuid, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.market_buy_listing(uuid, uuid, uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.market_seed_test_stock(uuid, uuid) TO heroloop_api;

COMMENT ON FUNCTION heroloop_api.market_seed_test_stock(uuid, uuid) IS
  'Staging-only transport fixture; the API environment gate must reject it elsewhere.';
