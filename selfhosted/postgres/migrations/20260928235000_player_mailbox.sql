-- Player Mailbox: server-owned items waiting outside the 64-slot bag.
-- Market purchases always arrive here; a cancelled Market listing and a Store
-- purchase arrive here only when the bag is full. The item stays in the
-- canonical player_items ledger owned by the player the whole time; the mail
-- row only records that it is not in the save inventory yet. Claiming moves
-- it into the bag one by one or as many as fit, atomically with the save.

CREATE TABLE IF NOT EXISTS public.player_mail_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.player_items(id),
  source text NOT NULL CHECK (source IN ('market_purchase', 'market_return', 'store_overflow')),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  outcome text CHECK (outcome IN ('claimed', 'already_in_bag', 'unavailable'))
);

CREATE UNIQUE INDEX IF NOT EXISTS player_mail_items_open_item
  ON public.player_mail_items(item_id) WHERE claimed_at IS NULL;
CREATE INDEX IF NOT EXISTS player_mail_items_open_player
  ON public.player_mail_items(player_id, created_at, id) WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.player_mail_claim_events (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.player_mail_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_mail_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_mail_items, public.player_mail_claim_events FROM PUBLIC;

-- Full client item shape, matching the canonical save projection.
CREATE OR REPLACE FUNCTION public.mail_item_json(p_item public.player_items)
RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'uid', p_item.id::text,
    'itemId', p_item.base_item_id,
    'level', p_item.item_level,
    'enchantLevel', p_item.enchant_level,
    'stats', p_item.stats,
    'power', p_item.power,
    'locked', p_item.locked,
    'rerollCount', p_item.reroll_count,
    'enchantStatsVersion', p_item.enchant_stats_version,
    'itemRollVersion', p_item.item_roll_version,
    'isNew', true,
    'serverOwned', true
  )
$function$;

CREATE OR REPLACE FUNCTION public.mail_deliver_item(p_player_id uuid, p_item_id uuid, p_source text, p_source_ref text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.player_items WHERE id = p_item_id AND player_id = p_player_id AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'item_not_found';
  END IF;
  INSERT INTO public.player_mail_items(player_id, item_id, source, source_ref)
    VALUES (p_player_id, p_item_id, p_source, left(p_source_ref, 80))
    RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.mail_list(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', mail.id, 'source', mail.source, 'created_at', mail.created_at, 'item', public.mail_item_json(item)
      ) ORDER BY mail.created_at, mail.id)
      FROM (
        SELECT * FROM public.player_mail_items
        WHERE player_id = p_player_id AND claimed_at IS NULL
        ORDER BY created_at, id LIMIT 200
      ) mail
      JOIN public.player_items item ON item.id = mail.item_id
    ), '[]'::jsonb)
  )
$function$;

-- p_mail_id NULL claims as many as fit, oldest first.
CREATE OR REPLACE FUNCTION heroloop_api.mail_claim(p_player_id uuid, p_idempotency_key uuid, p_mail_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_request jsonb := jsonb_build_object('mail_id', p_mail_id);
  v_existing public.player_mail_claim_events%ROWTYPE;
  v_state jsonb;
  v_inventory jsonb;
  v_revision bigint;
  v_free integer;
  v_mail public.player_mail_items%ROWTYPE;
  v_item public.player_items%ROWTYPE;
  v_claimed integer := 0;
  v_changed boolean := false;
  v_remaining integer;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.player_mail_claim_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;

  SELECT state, revision INTO v_state, v_revision FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_inventory := COALESCE(v_state->'inventory', '[]'::jsonb);
  v_free := 64 - public.server_market_bag_count(v_state);

  IF p_mail_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.player_mail_items WHERE id = p_mail_id AND player_id = p_player_id AND claimed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'mail_not_found';
  END IF;

  FOR v_mail IN
    SELECT * FROM public.player_mail_items
    WHERE player_id = p_player_id AND claimed_at IS NULL AND (p_mail_id IS NULL OR id = p_mail_id)
    ORDER BY created_at, id
    FOR UPDATE
  LOOP
    SELECT * INTO v_item FROM public.player_items
      WHERE id = v_mail.item_id AND player_id = p_player_id AND removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'unavailable' WHERE id = v_mail.id;
      CONTINUE;
    END IF;
    -- A save that already carries this uid must not get a second copy.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_inventory) entry WHERE entry->>'uid' = v_item.id::text) THEN
      UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'already_in_bag' WHERE id = v_mail.id;
      CONTINUE;
    END IF;
    IF v_free <= 0 THEN
      IF p_mail_id IS NOT NULL OR v_claimed = 0 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;
      EXIT;
    END IF;
    v_inventory := v_inventory || jsonb_build_array(public.mail_item_json(v_item));
    UPDATE public.player_mail_items SET claimed_at = now(), outcome = 'claimed' WHERE id = v_mail.id;
    v_free := v_free - 1;
    v_claimed := v_claimed + 1;
    v_changed := true;
  END LOOP;

  IF v_changed THEN
    v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  END IF;
  SELECT count(*) INTO v_remaining FROM public.player_mail_items WHERE player_id = p_player_id AND claimed_at IS NULL;
  v_result := jsonb_build_object('claimed', v_claimed, 'remaining', v_remaining, 'inventory', v_inventory, 'revision', v_revision);
  INSERT INTO public.player_mail_claim_events(idempotency_key, player_id, request, result)
    VALUES (p_idempotency_key, p_player_id, v_request, v_result);
  RETURN v_result;
END
$function$;

-- Market purchase: identical settlement, but the item goes to the Mailbox and
-- the bag limit no longer blocks buying.
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
  v_mail_id uuid;
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

  v_buyer_state := jsonb_set(v_buyer_state, '{hero}', to_jsonb(v_buyer_balance), true);
  v_seller_state := jsonb_set(v_seller_state, '{hero}', to_jsonb(v_seller_balance), true);
  UPDATE public.player_saves SET state = v_buyer_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_buyer_revision;
  UPDATE public.player_saves SET state = v_seller_state, revision = revision + 1, updated_at = now()
    WHERE player_id = v_listing.seller_id RETURNING revision INTO v_seller_revision;
  UPDATE public.player_items SET player_id = p_player_id WHERE id = v_listing.item_id;
  UPDATE public.market_item_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  v_mail_id := public.mail_deliver_item(p_player_id, v_listing.item_id, 'market_purchase', p_listing_id::text);

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
    'seller_revision', v_seller_revision,
    'delivered_to', 'mail',
    'mail_id', v_mail_id
  );
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'buy', v_request, v_result);
  RETURN v_result;
END;
$$;

-- Cancelling a listing with a full bag returns the item through the Mailbox.
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
  v_to_mail boolean;
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
  v_to_mail := public.server_market_bag_count(v_state) >= 64;
  IF v_to_mail THEN
    PERFORM public.mail_deliver_item(p_player_id, v_item.id, 'market_return', p_listing_id::text);
    UPDATE public.player_saves SET revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  ELSE
    v_inventory := v_inventory || jsonb_build_array(public.market_item_json(v_item));
    v_state := jsonb_set(v_state, '{inventory}', v_inventory, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  END IF;
  UPDATE public.market_item_listings SET status = 'cancelled', completed_at = now() WHERE id = p_listing_id;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;
  v_result := jsonb_build_object('listing_id', p_listing_id, 'inventory', v_inventory, 'token_balance', v_balance,
    'revision', v_revision, 'delivered_to', CASE WHEN v_to_mail THEN 'mail' ELSE 'inventory' END);
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'cancel', v_request, v_result);
  RETURN v_result;
END;
$$;

-- Store purchase keeps its live roll (v3/v5 patches) and changes only the
-- full-bag branch, so the patch fails closed if any anchor is missing.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.settle_store_purchase(uuid,uuid,integer,bigint)'::regprocedure);
  v_new := replace(v_def,
    $find$IF v_bag_count >= 64 THEN RAISE EXCEPTION 'item_capacity_exceeded'; END IF;$find$,
    '-- A full bag sends the purchase to the Mailbox.');
  v_new := replace(v_new,
    'v_inventory := v_inventory || jsonb_build_array(v_item);',
    $new$IF v_bag_count >= 64 THEN
    PERFORM public.mail_deliver_item(p_player_id, v_item_id, 'store_overflow', p_idempotency_key::text);
  ELSE
    v_inventory := v_inventory || jsonb_build_array(v_item);
  END IF;$new$);
  v_new := replace(v_new,
    $find$'slot_index', p_slot_index, 'price', v_price$find$,
    $find$'slot_index', p_slot_index, 'price', v_price,
    'delivered_to', CASE WHEN v_bag_count >= 64 THEN 'mail' ELSE 'inventory' END$find$);
  IF v_new NOT LIKE '%store_overflow%' OR v_new NOT LIKE '%''delivered_to''%'
    OR v_new LIKE '%RAISE EXCEPTION ''item_capacity_exceeded''%' THEN
    RAISE EXCEPTION 'mailbox_store_patch_failed';
  END IF;
  EXECUTE v_new;
END
$$;

-- The rate limiter rejects unregistered actions, including reads.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  IF to_regprocedure('heroloop_api.consume_rate_limit(uuid,text)') IS NULL THEN RETURN; END IF;
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''partner_quest_claim'',10,60),',
    '(''partner_quest_claim'',10,60),(''mail_list'',30,60),(''mail_claim'',20,60),');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'mailbox_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END
$$;

REVOKE ALL ON FUNCTION public.mail_item_json(public.player_items) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mail_deliver_item(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.mail_list(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_list(uuid) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.mail_claim(uuid,uuid,uuid) TO heroloop_api;
