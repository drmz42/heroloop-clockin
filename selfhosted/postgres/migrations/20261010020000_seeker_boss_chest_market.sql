-- Seeker Boss Chest Market (Founder decision 2026-10-09): Consumables trade Boss Chests.
-- Boss Chest loot follows the opener's Account Level, so Boss Chests are fungible: a listing
-- sells N of them as one lot for one price (bought whole). Timed (standard), tutorial and
-- account-bound chests never list. Listing reuses the SKR product `market_list_item` with
-- `item_id` = 'chest:boss:<quantity>' (quote kind `chest_listing`, same listing fee); buying
-- reuses `market_buy_listing` (quote kind `chest`, seller 90%, unchanged wallet split).
-- The listed chests leave the seller's save into escrow (the exact objects are kept) and
-- return on cancel; the buyer receives them in their chest queue. Refusals after payment are
-- definitive, so the listing fee or price is refunded.
BEGIN;

CREATE TABLE IF NOT EXISTS public.market_chest_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'boss'),
  chests jsonb NOT NULL CHECK (jsonb_typeof(chests) = 'array' AND jsonb_array_length(chests) BETWEEN 1 AND 100),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  price bigint NOT NULL CHECK (price BETWEEN 1 AND 100000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled')),
  buyer_id uuid REFERENCES public.players(player_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (jsonb_array_length(chests) = quantity)
);
CREATE INDEX IF NOT EXISTS market_chest_listings_active ON public.market_chest_listings(created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS market_chest_listings_seller ON public.market_chest_listings(seller_id, status);
ALTER TABLE public.market_chest_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_chest_listings FROM PUBLIC, anon, authenticated;

-- A tradable Boss Chest: boss, not tutorial, not account-bound.
CREATE OR REPLACE FUNCTION public.market_tradable_boss_chest(p_chest jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(p_chest) = 'object' AND COALESCE(p_chest->>'boss', 'false') = 'true'
    AND COALESCE(p_chest->>'tutorial', 'false') <> 'true' AND COALESCE(p_chest->>'bound', 'false') <> 'true'
$$;
REVOKE ALL ON FUNCTION public.market_tradable_boss_chest(jsonb) FROM PUBLIC, anon, authenticated;

-- 'chest:boss:<1..100>' -> quantity; anything else is refused.
CREATE OR REPLACE FUNCTION public.market_chest_listing_quantity(p_item_id text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v_match text[];
BEGIN
  v_match := regexp_match(COALESCE(p_item_id, ''), '^chest:boss:([1-9][0-9]{0,2})$');
  IF v_match IS NULL OR v_match[1]::integer > 100 THEN RAISE EXCEPTION 'invalid_chest_listing'; END IF;
  RETURN v_match[1]::integer;
END $$;
REVOKE ALL ON FUNCTION public.market_chest_listing_quantity(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_chest_listings_json(p_player_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', l.id, 'price', l.price, 'seller_id', l.seller_id, 'seller', COALESCE(p.username, 'Player'),
    'is_own', l.seller_id = p_player_id, 'created_at', l.created_at,
    'chest', jsonb_build_object('kind', l.kind, 'quantity', l.quantity)
  ) ORDER BY l.created_at DESC), '[]'::jsonb)
  FROM public.market_chest_listings l LEFT JOIN public.players p ON p.player_id = l.seller_id
  WHERE l.status = 'active'
$$;
REVOKE ALL ON FUNCTION public.market_chest_listings_json(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_list_chest(p_player_id uuid, p_idempotency_key uuid, p_item_id text, p_price bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('chest', p_item_id, 'price', p_price);
  v_quantity integer := public.market_chest_listing_quantity(p_item_id);
  v_state jsonb; v_chests jsonb; v_taken jsonb; v_rest jsonb;
  v_listing public.market_chest_listings%ROWTYPE; v_revision bigint; v_balance numeric; v_result jsonb;
BEGIN
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
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
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
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;
  INSERT INTO public.market_chest_listings(seller_id, kind, chests, quantity, price)
    VALUES (p_player_id, 'boss', v_taken, v_quantity, p_price) RETURNING * INTO v_listing;
  v_result := jsonb_build_object('listing_id', v_listing.id, 'chests', v_rest,
    'inventory', COALESCE(v_state->'inventory', '[]'::jsonb), 'token_balance', COALESCE(v_balance, 0), 'revision', v_revision);
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'list', v_request, v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_market_list_chest(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;

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
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
  -- Returned chests are the seller's own; they are not refused by a capacity check.
  v_chests := v_chests || v_listing.chests;
  v_state := jsonb_set(v_state, '{chests}', v_chests, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  SELECT token_balance INTO v_balance FROM public.players WHERE player_id = p_player_id;
  UPDATE public.market_chest_listings SET status = 'cancelled', completed_at = now() WHERE id = p_listing_id;
  v_result := jsonb_build_object('listing_id', p_listing_id, 'chests', v_chests,
    'inventory', COALESCE(v_state->'inventory', '[]'::jsonb), 'token_balance', COALESCE(v_balance, 0),
    'revision', v_revision, 'delivered_to', 'chests');
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'cancel', v_request, v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_market_cancel_chest(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The buyer's chest queue holds at most 1000 chests after the purchase.
CREATE OR REPLACE FUNCTION public.seeker_settle_market_buy_chest(p_player_id uuid, p_listing_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.market_chest_listings%ROWTYPE; v_state jsonb; v_chests jsonb; v_revision bigint;
BEGIN
  SELECT * INTO v_listing FROM public.market_chest_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_chests := COALESCE(v_state->'chests', '[]'::jsonb);
  IF jsonb_typeof(v_chests) <> 'array' THEN RAISE EXCEPTION 'invalid_save_state'; END IF;
  IF jsonb_array_length(v_chests) + v_listing.quantity > 1000 THEN RAISE EXCEPTION 'chest_capacity_exceeded'; END IF;
  v_chests := v_chests || v_listing.chests;
  v_state := jsonb_set(v_state, '{chests}', v_chests, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.market_chest_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  RETURN jsonb_build_object('listing_id', p_listing_id, 'chests', v_chests, 'revision', v_revision,
    'price', v_listing.price, 'delivered_to', 'chests');
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_market_buy_chest(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Quote: 'chest:boss:<n>' lists Boss Chests; a listing id may name a chest listing.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('market_chest_listings' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E' ELSIF p_action=''market_list_item'' THEN\n',
      E' ELSIF p_action=''market_list_item'' AND p_params->>''item_id'' LIKE ''chest:%'' THEN\n'
      || E'  IF (p_params->>''price'')::bigint NOT BETWEEN 1 AND 100000000 THEN RAISE EXCEPTION ''invalid_market_price''; END IF;\n'
      || E'  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;\n'
      || E'  IF v_state IS NULL THEN RAISE EXCEPTION ''save_not_found''; END IF;\n'
      || E'  IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(v_state->''chests'',''[]''::jsonb)) c WHERE public.market_tradable_boss_chest(c))\n'
      || E'    < public.market_chest_listing_quantity(p_params->>''item_id'') THEN RAISE EXCEPTION ''chest_not_found''; END IF;\n'
      || E'  IF (SELECT count(*) FROM public.market_chest_listings WHERE status=''active'' AND seller_id=p_player)>=20 THEN RAISE EXCEPTION ''market_chest_limit_reached''; END IF;\n'
      || E'  v_context:=v_context||jsonb_build_object(''kind'',''chest_listing'');\n'
      || E'  v_cents:=2;\n'
      || E' ELSIF p_action=''market_buy_listing'' AND EXISTS (SELECT 1 FROM public.market_chest_listings c WHERE c.id=(p_params->>''listing_id'')::uuid) THEN\n'
      || E'  SELECT c.id,c.id,c.seller_id,NULL::uuid,c.price,c.status,c.created_at,NULL::timestamptz INTO v_listing\n'
      || E'   FROM public.market_chest_listings c WHERE c.id=(p_params->>''listing_id'')::uuid AND c.status=''active'';\n'
      || E'  IF NOT FOUND THEN RAISE EXCEPTION ''market_listing_unavailable''; END IF;\n'
      || E'  IF v_listing.seller_id=p_player THEN RAISE EXCEPTION ''market_self_purchase''; END IF;\n'
      || E'  IF public.account_risk_level(v_listing.seller_id) IN (''review'',''hold'') THEN RAISE EXCEPTION ''market_listing_unavailable''; END IF;\n'
      || E'  SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;\n'
      || E'  IF v_state IS NULL THEN RAISE EXCEPTION ''save_not_found''; END IF;\n'
      || E'  IF jsonb_array_length(COALESCE(v_state->''chests'',''[]''::jsonb))+(SELECT quantity FROM public.market_chest_listings WHERE id=v_listing.id)>1000\n'
      || E'    THEN RAISE EXCEPTION ''chest_capacity_exceeded''; END IF;\n'
      || E'  v_cents:=v_listing.price;\n'
      || E'  v_context:=v_context||jsonb_build_object(''kind'',''chest'',''seller_id'',v_listing.seller_id);\n'
      || E' ELSIF p_action=''market_list_item'' THEN\n');
    IF v_new = v_def OR position('chest_listing' IN v_new) = 0 THEN RAISE EXCEPTION 'seeker_chest_market_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Delivery: list or buy chests; chest refusals are definitive (the payment is refunded).
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
  IF position('seeker_settle_market_list_chest' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  ELSIF r.action=''market_list_item'' AND r.context->>''kind''=''hero_listing'' THEN\n',
      E'  ELSIF r.action=''market_list_item'' AND r.context->>''kind''=''chest_listing'' THEN\n'
      || E'   v_result:=public.seeker_settle_market_list_chest(p_player,p_key,r.params->>''item_id'',(r.params->>''price'')::bigint);\n'
      || E'  ELSIF r.action=''market_buy_listing'' AND r.context->>''kind''=''chest'' THEN\n'
      || E'   IF public.account_risk_level((r.context->>''seller_id'')::uuid) IN (''review'',''hold'') THEN RAISE EXCEPTION ''market_listing_unavailable''; END IF;\n'
      || E'   PERFORM 1 FROM public.market_chest_listings WHERE id=(r.params->>''listing_id'')::uuid\n'
      || E'    AND seller_id=(r.context->>''seller_id'')::uuid AND price=r.usd_cents AND status=''active'' FOR UPDATE;\n'
      || E'   IF NOT FOUND THEN RAISE EXCEPTION ''market_listing_unavailable''; END IF;\n'
      || E'   v_result:=public.seeker_settle_market_buy_chest(p_player,(r.params->>''listing_id'')::uuid);\n'
      || E'  ELSIF r.action=''market_list_item'' AND r.context->>''kind''=''hero_listing'' THEN\n');
    v_new := replace(v_new, $old$IF v_code NOT IN ($old$,
      $new$IF v_code NOT IN ('chest_not_found','invalid_chest_listing','market_chest_limit_reached',$new$);
    IF v_new = v_def OR position('market_chest_limit_reached' IN v_new) = 0
      OR position('seeker_settle_market_buy_chest' IN v_new) = 0 THEN RAISE EXCEPTION 'seeker_chest_market_deliver_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Cancel: a chest listing returns its chests to the seller.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.market_cancel_listing(uuid,uuid,uuid)'::regprocedure);
  IF position('seeker_settle_market_cancel_chest' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  IF EXISTS (SELECT 1 FROM public.market_hero_listings WHERE id = p_listing_id) THEN\n',
      E'  IF EXISTS (SELECT 1 FROM public.market_chest_listings WHERE id = p_listing_id) THEN\n'
      || E'    RETURN public.seeker_settle_market_cancel_chest(p_player_id, p_idempotency_key, p_listing_id);\n'
      || E'  END IF;\n'
      || E'  IF EXISTS (SELECT 1 FROM public.market_hero_listings WHERE id = p_listing_id) THEN\n');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_chest_market_cancel_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Snapshot: chest listings beside item and hero listings.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.market_snapshot(uuid)'::regprocedure);
  IF position('chest_listings' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$RETURN jsonb_build_object('hero_listings',$old$,
      $new$RETURN jsonb_build_object('chest_listings', public.market_chest_listings_json(p_player_id), 'hero_listings',$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_chest_market_snapshot_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

COMMIT;
