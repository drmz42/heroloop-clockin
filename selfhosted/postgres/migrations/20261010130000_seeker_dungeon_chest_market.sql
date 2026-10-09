-- Seeker Dungeon Chest Market (Founder 2026-10-09): Consumables also trade Dungeon Chests
-- (Depth I, II, III). They live in the resource ledger (`dungeon_chest_d1..d3`), so a listing
-- debits the seller's stack into escrow (`market_chest_escrow`), cancel credits it back
-- (`market_chest_return`) and a purchase credits the buyer (`market_chest_purchase`, keyed by
-- the listing id). Lots, fees, quotes and refunds match Boss Chests: `item_id`
-- 'chest:dungeon<depth>:<quantity>', listing kinds `dungeon_d1..d3`. Merchant lots credit the
-- buyer without a seller debit (game-owned supply, paid to the treasury).
BEGIN;

ALTER TABLE public.market_chest_listings DROP CONSTRAINT IF EXISTS market_chest_listings_kind_check;
ALTER TABLE public.market_chest_listings ADD CONSTRAINT market_chest_listings_kind_check
  CHECK (kind IN ('boss','dungeon_d1','dungeon_d2','dungeon_d3'));

-- The ledger accepts the three Market source keys; reconciliation knows them.
DO $patch$
DECLARE d text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.apply_resource_entries(uuid,uuid,text,text,jsonb,bigint)',
    'public.resource_ledger_reconciliation()'] LOOP
    d := pg_get_functiondef(signature::regprocedure);
    IF position('market_chest_escrow' IN d) = 0 THEN
      IF length(d) - length(replace(d, '''dungeon_chest_open''', '')) <> length('''dungeon_chest_open''') THEN
        RAISE EXCEPTION 'dungeon_chest_market_resource_definition_mismatch';
      END IF;
      d := replace(d, '''dungeon_chest_open''', '''dungeon_chest_open'',''market_chest_escrow'',''market_chest_return'',''market_chest_purchase''');
      EXECUTE d;
    END IF;
  END LOOP;
END $patch$;

-- 'chest:boss:<n>' or 'chest:dungeon<1-3>:<n>' -> (listing kind, quantity 1..100).
CREATE OR REPLACE FUNCTION public.market_chest_listing_parse(p_item_id text, OUT kind text, OUT quantity integer)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v_match text[];
BEGIN
  v_match := regexp_match(COALESCE(p_item_id, ''), '^chest:(boss|dungeon[1-3]):([1-9][0-9]{0,2})$');
  IF v_match IS NULL OR v_match[2]::integer > 100 THEN RAISE EXCEPTION 'invalid_chest_listing'; END IF;
  kind := CASE v_match[1] WHEN 'boss' THEN 'boss' ELSE 'dungeon_d' || right(v_match[1], 1) END;
  quantity := v_match[2]::integer;
END $$;
REVOKE ALL ON FUNCTION public.market_chest_listing_parse(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_chest_listing_quantity(p_item_id text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT (public.market_chest_listing_parse(p_item_id)).quantity
$$;

CREATE OR REPLACE FUNCTION public.market_chest_resource(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_kind WHEN 'dungeon_d1' THEN 'dungeon_chest_d1' WHEN 'dungeon_d2' THEN 'dungeon_chest_d2'
    WHEN 'dungeon_d3' THEN 'dungeon_chest_d3' END
$$;
REVOKE ALL ON FUNCTION public.market_chest_resource(text) FROM PUBLIC, anon, authenticated;

-- The seller holds enough tradable chests of the listed kind.
CREATE OR REPLACE FUNCTION public.market_chest_listing_available(p_player_id uuid, p_item_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_kind text; v_quantity integer;
BEGIN
  SELECT parsed.kind, parsed.quantity INTO v_kind, v_quantity FROM public.market_chest_listing_parse(p_item_id) parsed;
  IF v_kind = 'boss' THEN
    RETURN (SELECT count(*) FROM public.player_saves s, jsonb_array_elements(COALESCE(s.state->'chests', '[]'::jsonb)) c
      WHERE s.player_id = p_player_id AND jsonb_typeof(s.state->'chests') = 'array' AND public.market_tradable_boss_chest(c)) >= v_quantity;
  END IF;
  RETURN COALESCE((SELECT quantity_bigint FROM public.player_resource_balances
    WHERE player_id = p_player_id AND resource_id = public.market_chest_resource(v_kind)), 0) >= v_quantity;
END $$;
REVOKE ALL ON FUNCTION public.market_chest_listing_available(uuid, text) FROM PUBLIC, anon, authenticated;

-- Boss Chests join the save queue (at most 1,000 chests); ledger stacks have their own cap.
CREATE OR REPLACE FUNCTION public.market_chest_buy_fits(p_player_id uuid, p_listing_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN l.kind = 'boss' THEN
      jsonb_array_length(COALESCE((SELECT state->'chests' FROM public.player_saves WHERE player_id = p_player_id), '[]'::jsonb)) + l.quantity <= 1000
    ELSE COALESCE((SELECT b.quantity_bigint FROM public.player_resource_balances b
      WHERE b.player_id = p_player_id AND b.resource_id = public.market_chest_resource(l.kind)), 0) + l.quantity <= 1000000 END
  FROM public.market_chest_listings l WHERE l.id = p_listing_id
$$;
REVOKE ALL ON FUNCTION public.market_chest_buy_fits(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- One ledger movement of a Dungeon Chest stack, keyed by the caller's idempotency key.
CREATE OR REPLACE FUNCTION public.market_chest_ledger_move(p_player_id uuid, p_key uuid, p_kind text, p_delta integer, p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  RETURN public.apply_resource_entries(p_player_id, p_key, 'market_chest_' || replace(p_source, 'market_chest_', ''),
    encode(extensions.digest(('market-chest:' || p_key::text || ':' || p_kind || ':' || p_delta::text || ':' || p_source)::bytea, 'sha256'), 'hex'),
    jsonb_build_array(jsonb_build_object('resource_id', public.market_chest_resource(p_kind), 'delta', p_delta::text, 'source_key', p_source)));
END $$;
REVOKE ALL ON FUNCTION public.market_chest_ledger_move(uuid, uuid, text, integer, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_list_chest(p_player_id uuid, p_idempotency_key uuid, p_item_id text, p_price bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('chest', p_item_id, 'price', p_price);
  v_kind text; v_quantity integer;
  v_state jsonb; v_chests jsonb; v_taken jsonb; v_rest jsonb;
  v_listing public.market_chest_listings%ROWTYPE; v_revision bigint; v_balance numeric; v_result jsonb;
BEGIN
  SELECT parsed.kind, parsed.quantity INTO v_kind, v_quantity FROM public.market_chest_listing_parse(p_item_id) parsed;
  IF p_price < 1 OR p_price > 100000000 THEN RAISE EXCEPTION 'invalid_market_price'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'list' OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('market-chest-seller-limit:' || p_player_id::text, 0));
  IF (SELECT count(*) FROM public.market_chest_listings WHERE status = 'active' AND seller_id = p_player_id) >= 20 THEN
    RAISE EXCEPTION 'market_chest_limit_reached';
  END IF;
  SELECT state, revision INTO v_state, v_revision FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
  IF v_kind = 'boss' THEN
    -- Take the first N tradable Boss Chests; every other chest keeps its order.
    WITH numbered AS (
      SELECT c, o, public.market_tradable_boss_chest(c) AND
        count(*) FILTER (WHERE public.market_tradable_boss_chest(c)) OVER (ORDER BY o) <= v_quantity AS taken
      FROM jsonb_array_elements(v_chests) WITH ORDINALITY e(c, o)
    )
    SELECT COALESCE(jsonb_agg(c ORDER BY o) FILTER (WHERE taken), '[]'::jsonb),
           COALESCE(jsonb_agg(c ORDER BY o) FILTER (WHERE NOT taken), '[]'::jsonb)
      INTO v_taken, v_rest FROM numbered;
    IF jsonb_array_length(v_taken) < v_quantity THEN RAISE EXCEPTION 'chest_not_found'; END IF;
    v_state := jsonb_set(v_state, '{chests}', v_rest, true);
    v_chests := v_rest;
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  ELSE
    IF NOT public.market_chest_listing_available(p_player_id, p_item_id) THEN RAISE EXCEPTION 'chest_not_found'; END IF;
    PERFORM public.market_chest_ledger_move(p_player_id, p_idempotency_key, v_kind, -v_quantity, 'market_chest_escrow');
    SELECT jsonb_agg(jsonb_build_object('dungeon', right(v_kind, 1)::integer)) INTO v_taken FROM generate_series(1, v_quantity);
  END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;
  INSERT INTO public.market_chest_listings(seller_id, kind, chests, quantity, price)
    VALUES (p_player_id, v_kind, v_taken, v_quantity, p_price) RETURNING * INTO v_listing;
  v_result := jsonb_build_object('listing_id', v_listing.id, 'chests', v_chests, 'dungeon_chests', public.dungeon_chest_balances(p_player_id),
    'inventory', COALESCE(v_state->'inventory', '[]'::jsonb), 'token_balance', COALESCE(v_balance, 0), 'revision', v_revision);
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'list', v_request, v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_cancel_chest(p_player_id uuid, p_idempotency_key uuid, p_listing_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_chest_listings%ROWTYPE; v_state jsonb; v_chests jsonb;
  v_revision bigint; v_balance numeric; v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'cancel' OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_listing FROM public.market_chest_listings WHERE id = p_listing_id AND seller_id = p_player_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  SELECT state, revision INTO v_state, v_revision FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
  IF v_listing.kind = 'boss' THEN
    -- Returned chests are the seller's own; they are not refused by a capacity check.
    v_chests := v_chests || v_listing.chests;
    v_state := jsonb_set(v_state, '{chests}', v_chests, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  ELSE
    PERFORM public.market_chest_ledger_move(p_player_id, p_idempotency_key, v_listing.kind, v_listing.quantity, 'market_chest_return');
  END IF;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;
  UPDATE public.market_chest_listings SET status = 'cancelled', completed_at = now() WHERE id = p_listing_id;
  v_result := jsonb_build_object('listing_id', p_listing_id, 'chests', v_chests, 'dungeon_chests', public.dungeon_chest_balances(p_player_id),
    'inventory', COALESCE(v_state->'inventory', '[]'::jsonb), 'token_balance', COALESCE(v_balance, 0),
    'revision', v_revision, 'delivered_to', 'chests');
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'cancel', v_request, v_result);
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_buy_chest(p_player_id uuid, p_listing_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.market_chest_listings%ROWTYPE; v_state jsonb; v_chests jsonb; v_revision bigint;
BEGIN
  SELECT * INTO v_listing FROM public.market_chest_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;
  IF NOT public.market_chest_buy_fits(p_player_id, p_listing_id) THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;
  SELECT state, revision INTO v_state, v_revision FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
  IF v_listing.kind = 'boss' THEN
    v_chests := v_chests || v_listing.chests;
    v_state := jsonb_set(v_state, '{chests}', v_chests, true);
    UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
      WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  ELSE
    PERFORM public.market_chest_ledger_move(p_player_id, p_listing_id, v_listing.kind, v_listing.quantity, 'market_chest_purchase');
  END IF;
  UPDATE public.market_chest_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  RETURN jsonb_build_object('listing_id', p_listing_id, 'chests', v_chests, 'dungeon_chests', public.dungeon_chest_balances(p_player_id),
    'revision', v_revision, 'price', v_listing.price, 'delivered_to', 'chests');
END $$;

-- Quotes check the listed kind and the buyer's room for it.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('market_chest_listing_available' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$  IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_state->'chests','[]'::jsonb)) c WHERE public.market_tradable_boss_chest(c))
    < public.market_chest_listing_quantity(p_params->>'item_id') THEN RAISE EXCEPTION 'chest_not_found'; END IF;$old$,
      $new$  IF NOT public.market_chest_listing_available(p_player,p_params->>'item_id') THEN RAISE EXCEPTION 'chest_not_found'; END IF;$new$);
    v_new := replace(v_new,
      $old$  IF jsonb_array_length(COALESCE(v_state->'chests','[]'::jsonb))+(SELECT quantity FROM public.market_chest_listings WHERE id=v_listing.id)>1000
    THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;$old$,
      $new$  IF NOT public.market_chest_buy_fits(p_player,v_listing.id) THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;$new$);
    IF position('market_chest_listing_available' IN v_new) = 0 OR position('market_chest_buy_fits' IN v_new) = 0 THEN
      RAISE EXCEPTION 'seeker_dungeon_chest_market_prepare_patch_failed';
    END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Sales name each lot by its kind.
CREATE OR REPLACE FUNCTION public.market_chest_lot_name(p_kind text, p_quantity integer) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_kind WHEN 'boss' THEN 'Boss Chest' WHEN 'dungeon_d1' THEN 'Dungeon Chest I'
    WHEN 'dungeon_d2' THEN 'Dungeon Chest II' ELSE 'Dungeon Chest III' END || ' ×' || p_quantity
$$;

DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.seeker_market_sales_feed(uuid,integer)'::regprocedure);
  IF position('market_chest_lot_name' IN v_def) = 0 THEN
    v_new := replace(v_def, $old$'Boss Chest ×' || chest.quantity$old$, $new$public.market_chest_lot_name(chest.kind, chest.quantity)$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_dungeon_chest_feed_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Merchant Dungeon Chest lots (once per seed tag), priced per chest like Boss Chest lots.
CREATE OR REPLACE FUNCTION public.seeker_house_dungeon_chest_market_seed(p_seed text, p_depth integer, p_lots integer,
  p_min integer, p_max integer, p_cent_lo integer, p_cent_hi integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing jsonb; v_ids uuid[]; v_quantity integer; v_chests_total integer := 0; v_chests jsonb; i integer;
BEGIN
  IF p_seed IS NULL OR p_seed !~ '^[a-z0-9-]{3,64}$' OR p_depth NOT BETWEEN 1 AND 3 OR p_lots NOT BETWEEN 1 AND 200
    OR p_min NOT BETWEEN 1 AND 100 OR p_max NOT BETWEEN p_min AND 100
    OR p_cent_lo NOT BETWEEN 1 AND 100000 OR p_cent_hi NOT BETWEEN p_cent_lo AND 100000 THEN
    RAISE EXCEPTION 'invalid_house_market_seed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('seeker-house-market-seed', 0));
  SELECT summary INTO v_existing FROM public.seeker_house_market_seeds WHERE seed = p_seed;
  IF FOUND THEN RETURN v_existing; END IF;
  SELECT array_agg(player_id ORDER BY player_id) INTO v_ids FROM public.seeker_house_sellers;
  IF v_ids IS NULL THEN RAISE EXCEPTION 'house_merchants_missing'; END IF;
  FOR i IN 1..p_lots LOOP
    v_quantity := p_min + floor(random() * (p_max - p_min + 1))::integer;
    SELECT jsonb_agg(jsonb_build_object('dungeon', p_depth)) INTO v_chests FROM generate_series(1, v_quantity);
    INSERT INTO public.market_chest_listings(seller_id, kind, chests, quantity, price, created_at)
      VALUES (v_ids[1 + floor(random() * cardinality(v_ids))::integer], 'dungeon_d' || p_depth, v_chests, v_quantity,
        LEAST(100000000, v_quantity * (p_cent_lo + floor(random() * (p_cent_hi - p_cent_lo + 1))::integer)),
        now() - random() * interval '24 hours');
    v_chests_total := v_chests_total + v_quantity;
  END LOOP;
  v_existing := jsonb_build_object('seed', p_seed, 'depth', p_depth, 'chest_lots', p_lots, 'chests', v_chests_total, 'merchants', cardinality(v_ids));
  INSERT INTO public.seeker_house_market_seeds(seed, summary) VALUES (p_seed, v_existing);
  RETURN v_existing;
END $$;
REVOKE ALL ON FUNCTION public.seeker_house_dungeon_chest_market_seed(text, integer, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;

COMMIT;
