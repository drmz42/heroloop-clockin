CREATE TABLE IF NOT EXISTS public.market_item_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.player_items(id),
  seller_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  buyer_id uuid REFERENCES public.players(player_id) ON DELETE SET NULL,
  price bigint NOT NULL CHECK (price BETWEEN 1 AND 1000000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS market_item_listings_active_item
  ON public.market_item_listings(item_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS market_item_listings_active_created
  ON public.market_item_listings(created_at DESC) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.market_item_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('list', 'cancel', 'buy')),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.market_fee_daily_pool (
  day_key date PRIMARY KEY,
  fee_total bigint NOT NULL DEFAULT 0 CHECK (fee_total >= 0),
  trade_count integer NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.market_item_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_fee_daily_pool ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_item_listings, public.market_item_events, public.market_fee_daily_pool FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_item_json(p_item public.player_items)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'uid', p_item.id::text,
    'itemId', p_item.base_item_id,
    'level', p_item.item_level,
    'enchantLevel', p_item.enchant_level,
    'stats', p_item.stats,
    'power', p_item.power,
    'locked', p_item.locked,
    'isNew', false,
    'serverOwned', true
  )
$$;

CREATE OR REPLACE FUNCTION public.market_listing_json(p_listing public.market_item_listings)
RETURNS jsonb
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', p_listing.id,
    'price', p_listing.price,
    'seller_id', p_listing.seller_id,
    'seller', COALESCE(player.username, 'Player'),
    'created_at', p_listing.created_at,
    'item', public.market_item_json(item)
  )
  FROM public.player_items item
  LEFT JOIN public.players player ON player.player_id = p_listing.seller_id
  WHERE item.id = p_listing.item_id
$$;

CREATE OR REPLACE FUNCTION public.server_market_bag_count(p_state jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  WITH equipped AS (
    SELECT equipped.value AS item_id
    FROM jsonb_array_elements(COALESCE(p_state->'ownedHeroes', '[]'::jsonb)) hero,
      LATERAL jsonb_each_text(COALESCE(hero->'equipped', '{}'::jsonb)) equipped
  )
  SELECT count(*)::integer
  FROM jsonb_array_elements(COALESCE(p_state->'inventory', '[]'::jsonb)) item
  WHERE NOT EXISTS (SELECT 1 FROM equipped WHERE equipped.item_id = item->>'uid')
$$;

CREATE OR REPLACE FUNCTION public.market_snapshot(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listings jsonb;
  v_history jsonb;
  v_pool public.market_fee_daily_pool%ROWTYPE;
  v_day date := (now() AT TIME ZONE 'Europe/Moscow')::date;
BEGIN
  SELECT COALESCE(jsonb_agg(
      public.market_listing_json(listing) || jsonb_build_object('is_own', listing.seller_id = p_player_id)
      ORDER BY listing.created_at DESC
    ), '[]'::jsonb)
    INTO v_listings
  FROM public.market_item_listings listing
  WHERE listing.status = 'active';

  SELECT COALESCE(jsonb_agg(entry ORDER BY occurred_at DESC), '[]'::jsonb)
    INTO v_history
  FROM (
    SELECT jsonb_build_object(
      'id', listing.id,
      'name', COALESCE(item.base_item_id, 'Item'),
      'price', listing.price,
      'createdAt', floor(extract(epoch FROM listing.completed_at) * 1000),
      'action', CASE WHEN listing.seller_id = p_player_id THEN 'sold' ELSE 'bought' END
    ) AS entry, listing.completed_at AS occurred_at
    FROM public.market_item_listings listing
    LEFT JOIN public.player_items item ON item.id = listing.item_id
    WHERE listing.status = 'sold' AND (listing.seller_id = p_player_id OR listing.buyer_id = p_player_id)
    ORDER BY listing.completed_at DESC
    LIMIT 30
  ) history;

  SELECT * INTO v_pool FROM public.market_fee_daily_pool WHERE day_key = v_day;
  RETURN jsonb_build_object(
    'listings', v_listings,
    'history', v_history,
    'active_limit', 2,
    'fee_percent', 5,
    'pool_day', v_day,
    'pool_fee_total', COALESCE(v_pool.fee_total, 0),
    'pool_trade_count', COALESCE(v_pool.trade_count, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_market_list(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_item_id uuid,
  p_price bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('item_id', p_item_id, 'price', p_price);
  v_item public.player_items%ROWTYPE;
  v_state jsonb;
  v_listing public.market_item_listings%ROWTYPE;
  v_inventory jsonb;
  v_revision bigint;
  v_balance numeric;
  v_result jsonb;
BEGIN
  IF p_price < 1 OR p_price > 1000000000 THEN RAISE EXCEPTION 'invalid_market_price'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'list' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('market-active-limit', 0));
  IF (SELECT count(*) FROM public.market_item_listings WHERE status = 'active') >= 2 THEN
    RAISE EXCEPTION 'market_test_limit_reached';
  END IF;

  SELECT * INTO v_item FROM public.player_items
    WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  IF v_item.locked THEN RAISE EXCEPTION 'item_locked'; END IF;
  IF v_item.rarity <> 'legendary' OR v_item.slot NOT IN ('weapon', 'class_weapon') THEN
    RAISE EXCEPTION 'market_test_item_required';
  END IF;

  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) entry WHERE entry->>'uid' = p_item_id::text) THEN
    RAISE EXCEPTION 'item_state_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes', '[]'::jsonb)) hero,
      LATERAL jsonb_each_text(COALESCE(hero->'equipped', '{}'::jsonb)) equipped
    WHERE equipped.value = p_item_id::text
  ) THEN RAISE EXCEPTION 'item_equipped'; END IF;

  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb) INTO v_inventory
  FROM jsonb_array_elements(COALESCE(v_state->'inventory', '[]'::jsonb)) entry
  WHERE entry->>'uid' <> p_item_id::text;
  v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;

  INSERT INTO public.market_item_listings(item_id, seller_id, price)
    VALUES (p_item_id, p_player_id, p_price) RETURNING * INTO v_listing;
  v_result := jsonb_build_object(
    'listing', public.market_listing_json(v_listing),
    'inventory', v_inventory,
    'token_balance', v_balance,
    'revision', v_revision
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'list', v_request, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_market_cancel(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_item_listings%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_revision bigint;
  v_balance numeric;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'cancel' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_listing FROM public.market_item_listings
    WHERE id = p_listing_id AND seller_id = p_player_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  SELECT * INTO v_item FROM public.player_items WHERE id = v_listing.item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  IF public.server_market_bag_count(v_state) >= 64 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;
  v_inventory := v_inventory || jsonb_build_array(public.market_item_json(v_item));
  v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.market_item_listings SET status = 'cancelled', completed_at = now() WHERE id = p_listing_id;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;
  v_result := jsonb_build_object('listing_id', p_listing_id, 'inventory', v_inventory, 'token_balance', v_balance, 'revision', v_revision);
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'cancel', v_request, v_result);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_market_buy(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_listing_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_item_listings%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_buyer_state jsonb;
  v_seller_state jsonb;
  v_inventory jsonb;
  v_buyer_balance numeric;
  v_seller_balance numeric;
  v_seller_proceeds bigint;
  v_fee bigint;
  v_buyer_revision bigint;
  v_seller_revision bigint;
  v_day date := (now() AT TIME ZONE 'Europe/Moscow')::date;
  v_pool_total bigint;
  v_pool_trades integer;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'buy' OR v_existing.request <> v_request THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN v_existing.result;
  END IF;

  SELECT * INTO v_listing FROM public.market_item_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;

  PERFORM player_id FROM public.players
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  SELECT token_balance INTO v_buyer_balance FROM public.players WHERE player_id = p_player_id;
  SELECT token_balance INTO v_seller_balance FROM public.players WHERE player_id = v_listing.seller_id;
  IF v_buyer_balance < v_listing.price THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;

  PERFORM player_id FROM public.player_saves
    WHERE player_id IN (p_player_id, v_listing.seller_id) ORDER BY player_id FOR UPDATE;
  SELECT state INTO v_buyer_state FROM public.player_saves WHERE player_id = p_player_id;
  SELECT state INTO v_seller_state FROM public.player_saves WHERE player_id = v_listing.seller_id;
  IF v_buyer_state IS NULL OR v_seller_state IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_buyer_state->'inventory', '[]'::jsonb);
  IF public.server_market_bag_count(v_buyer_state) >= 64 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;

  SELECT * INTO v_item FROM public.player_items
    WHERE id = v_listing.item_id AND player_id = v_listing.seller_id AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;

  v_seller_proceeds := floor(v_listing.price * 95::numeric / 100)::bigint;
  v_fee := v_listing.price - v_seller_proceeds;
  UPDATE public.players SET token_balance = token_balance - v_listing.price,
      boost_tokens_spent = boost_tokens_spent + v_listing.price, updated_at = now()
    WHERE player_id = p_player_id RETURNING token_balance INTO v_buyer_balance;
  UPDATE public.players SET token_balance = token_balance + v_seller_proceeds, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING token_balance INTO v_seller_balance;

  v_inventory := v_inventory || jsonb_build_array(public.market_item_json(v_item));
  v_buyer_state := jsonb_set(jsonb_set(v_buyer_state, '{inventory}', v_inventory, true), '{hero}', to_jsonb(v_buyer_balance), true);
  v_seller_state := jsonb_set(v_seller_state, '{hero}', to_jsonb(v_seller_balance), true);
  UPDATE public.player_saves SET state = v_buyer_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_buyer_revision;
  UPDATE public.player_saves SET state = v_seller_state, revision = revision + 1, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING revision INTO v_seller_revision;
  UPDATE public.player_items SET player_id = p_player_id WHERE id = v_listing.item_id;
  UPDATE public.market_item_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;

  INSERT INTO public.market_fee_daily_pool(day_key, fee_total, trade_count)
    VALUES (v_day, v_fee, 1)
    ON CONFLICT (day_key) DO UPDATE SET
      fee_total = public.market_fee_daily_pool.fee_total + EXCLUDED.fee_total,
      trade_count = public.market_fee_daily_pool.trade_count + 1,
      updated_at = now()
    RETURNING fee_total, trade_count INTO v_pool_total, v_pool_trades;

  v_result := jsonb_build_object(
    'listing_id', p_listing_id,
    'item', public.market_item_json(v_item),
    'inventory', v_inventory,
    'token_balance', v_buyer_balance,
    'price', v_listing.price,
    'seller_proceeds', v_seller_proceeds,
    'fee', v_fee,
    'pool_fee_total', v_pool_total,
    'pool_trade_count', v_pool_trades,
    'revision', v_buyer_revision,
    'seller_revision', v_seller_revision
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'buy', v_request, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.market_item_json(public.player_items) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_listing_json(public.market_item_listings) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_market_bag_count(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.market_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_market_list(uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_market_cancel(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_market_buy(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_snapshot(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_market_list(uuid, uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_market_cancel(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_market_buy(uuid, uuid, uuid) TO service_role;
