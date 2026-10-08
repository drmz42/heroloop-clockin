-- Seeker player hero Market (Founder decision 2026-10-08): players list their own heroes.
-- Listing uses the existing SKR product `market_list_item` (its `item_id` names the hero
-- uid; the quote is marked `kind: hero`) and pays the same listing fee. The hero leaves the
-- roster into `market_hero_listings` escrow; a buyer pays through `market_buy_listing`
-- (seller wallet 90%, fees 10%, unchanged wallet split); cancel returns the hero.
-- Guards match Hero Release: not the last hero, not locked, not in the team or Training,
-- nothing equipped. Refusals after payment are definitive, so the listing fee is refunded.
BEGIN;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_list_hero(p_player_id uuid, p_idempotency_key uuid, p_hero_uid text, p_price bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('hero_uid', p_hero_uid, 'price', p_price);
  v_state jsonb; v_owned jsonb; v_target jsonb; v_listing public.market_hero_listings%ROWTYPE;
  v_revision bigint; v_balance numeric; v_result jsonb;
BEGIN
  IF p_price < 1 OR p_price > 1000000000 THEN RAISE EXCEPTION 'invalid_market_price'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'list' OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('market-hero-seller-limit:' || p_player_id::text, 0));
  IF (SELECT count(*) FROM public.market_hero_listings WHERE status = 'active' AND seller_id = p_player_id) >= 20 THEN
    RAISE EXCEPTION 'market_hero_limit_reached';
  END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  SELECT hero INTO v_target FROM jsonb_array_elements(v_owned) AS owned(hero) WHERE hero->>'uid' = p_hero_uid LIMIT 1;
  IF v_target IS NULL THEN RAISE EXCEPTION 'hero_not_found'; END IF;
  IF jsonb_array_length(v_owned) = 1 THEN RAISE EXCEPTION 'last_hero'; END IF;
  IF COALESCE((v_target->>'locked')::boolean, false) THEN RAISE EXCEPTION 'hero_locked'; END IF;
  IF COALESCE(v_state->'team', '[]'::jsonb) ? p_hero_uid THEN RAISE EXCEPTION 'hero_in_team'; END IF;
  IF COALESCE(v_state#>'{trainingCamp,heroUids}', '[]'::jsonb) ? p_hero_uid THEN RAISE EXCEPTION 'hero_in_training'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(v_target->'equipped', '{}'::jsonb)) equipped
    WHERE jsonb_typeof(equipped.value) = 'string' AND trim(BOTH '"' FROM equipped.value::text) <> '') THEN
    RAISE EXCEPTION 'hero_has_equipment';
  END IF;
  SELECT COALESCE(jsonb_agg(hero), '[]'::jsonb) INTO v_owned FROM jsonb_array_elements(v_owned) AS owned(hero) WHERE hero->>'uid' <> p_hero_uid;
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET heroes_owned = jsonb_array_length(v_owned) WHERE player_id = p_player_id
    RETURNING token_balance INTO v_balance;
  INSERT INTO public.market_hero_listings(seller_id, hero, price)
    VALUES (p_player_id, jsonb_build_object('uid', p_hero_uid, 'heroId', v_target->>'heroId',
      'level', GREATEST(1, COALESCE((v_target->>'level')::integer, 1)), 'stars', GREATEST(0, COALESCE((v_target->>'stars')::integer, 0)),
      'xp', GREATEST(0, COALESCE((v_target->>'xp')::numeric, 0))), p_price)
    RETURNING * INTO v_listing;
  v_result := jsonb_build_object('listing_id', v_listing.id, 'owned_heroes', v_owned,
    'inventory', COALESCE(v_state->'inventory', '[]'::jsonb), 'token_balance', COALESCE(v_balance, 0), 'revision', v_revision);
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'list', v_request, v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_market_list_hero(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.seeker_settle_market_cancel_hero(p_player_id uuid, p_idempotency_key uuid, p_listing_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.market_item_events%ROWTYPE;
  v_request jsonb := jsonb_build_object('listing_id', p_listing_id);
  v_listing public.market_hero_listings%ROWTYPE; v_state jsonb; v_owned jsonb; v_hero jsonb;
  v_revision bigint; v_balance numeric; v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.market_item_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id OR v_existing.action <> 'cancel' OR v_existing.request <> v_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN v_existing.result;
  END IF;
  SELECT * INTO v_listing FROM public.market_hero_listings WHERE id = p_listing_id AND seller_id = p_player_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_array_length(v_owned) + 1 > COALESCE((v_state->>'heroCapacity')::integer, 500) THEN RAISE EXCEPTION 'hero_capacity_exceeded'; END IF;
  v_hero := jsonb_build_object('uid', COALESCE(v_listing.hero->>'uid', gen_random_uuid()::text), 'heroId', v_listing.hero->>'heroId',
    'level', GREATEST(1, (v_listing.hero->>'level')::integer), 'stars', GREATEST(0, (v_listing.hero->>'stars')::integer),
    'equipped', '{}'::jsonb, 'xp', COALESCE((v_listing.hero->>'xp')::numeric, 0));
  v_owned := v_owned || jsonb_build_array(v_hero);
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET heroes_owned = jsonb_array_length(v_owned) WHERE player_id = p_player_id RETURNING token_balance INTO v_balance;
  UPDATE public.market_hero_listings SET status = 'cancelled', completed_at = now() WHERE id = p_listing_id;
  v_result := jsonb_build_object('listing_id', p_listing_id, 'owned_heroes', v_owned, 'hero', v_hero,
    'inventory', COALESCE(v_state->'inventory', '[]'::jsonb), 'token_balance', COALESCE(v_balance, 0),
    'revision', v_revision, 'delivered_to', 'heroes');
  INSERT INTO public.market_item_events(idempotency_key, player_id, action, request, result)
    VALUES (p_idempotency_key, p_player_id, 'cancel', v_request, v_result);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_market_cancel_hero(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- A bought hero keeps its level, stars and XP; it gets a new uid and nothing equipped.
CREATE OR REPLACE FUNCTION public.seeker_settle_market_buy_hero(p_player_id uuid, p_listing_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.market_hero_listings%ROWTYPE;
  v_state jsonb; v_owned jsonb; v_hero jsonb; v_revision bigint;
BEGIN
  SELECT * INTO v_listing FROM public.market_hero_listings WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.status <> 'active' THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
  IF v_listing.seller_id = p_player_id THEN RAISE EXCEPTION 'market_self_purchase'; END IF;
  SELECT state INTO v_state FROM public.player_saves WHERE player_id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_not_found'; END IF;
  v_owned := COALESCE(v_state->'ownedHeroes', '[]'::jsonb);
  IF jsonb_typeof(v_owned) <> 'array' THEN RAISE EXCEPTION 'invalid_owned_heroes'; END IF;
  IF jsonb_array_length(v_owned) + 1 > COALESCE((v_state->>'heroCapacity')::integer, 500) THEN
    RAISE EXCEPTION 'hero_capacity_exceeded';
  END IF;
  v_hero := jsonb_build_object('uid', gen_random_uuid()::text, 'heroId', v_listing.hero->>'heroId',
    'level', GREATEST(1, (v_listing.hero->>'level')::integer), 'stars', GREATEST(0, (v_listing.hero->>'stars')::integer),
    'equipped', '{}'::jsonb, 'xp', COALESCE((v_listing.hero->>'xp')::numeric, 0), 'isNew', true);
  v_owned := v_owned || jsonb_build_array(v_hero);
  v_state := jsonb_set(v_state, '{ownedHeroes}', v_owned, true);
  UPDATE public.player_saves SET state = v_state, revision = revision + 1, updated_at = now()
    WHERE player_id = p_player_id RETURNING revision INTO v_revision;
  UPDATE public.players SET heroes_owned = jsonb_array_length(v_owned) WHERE player_id = p_player_id;
  UPDATE public.market_hero_listings SET status = 'sold', buyer_id = p_player_id, completed_at = now() WHERE id = p_listing_id;
  RETURN jsonb_build_object('listing_id', p_listing_id, 'hero', v_hero, 'owned_heroes', v_owned,
    'revision', v_revision, 'price', v_listing.price, 'delivered_to', 'heroes');
END $$;
REVOKE ALL ON FUNCTION public.seeker_settle_market_buy_hero(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Quote: market_list_item may name one of the player's heroes.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position($m$'kind','hero_listing')$m$ IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$  PERFORM 1 FROM public.player_items WHERE id=(p_params->>'item_id')::uuid AND player_id=p_player AND removed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;$old$,
      $new$  PERFORM 1 FROM public.player_items WHERE id=(p_params->>'item_id')::uuid AND player_id=p_player AND removed_at IS NULL;
  IF NOT FOUND THEN
   SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
   IF v_state IS NULL OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_state->'ownedHeroes','[]'::jsonb)) hero
     WHERE hero->>'uid'=p_params->>'item_id') THEN RAISE EXCEPTION 'item_not_found'; END IF;
   v_context:=v_context||jsonb_build_object('kind','hero_listing');
  END IF;$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_player_hero_market_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Delivery: list the hero; hero refusals are definitive (the listing fee is refunded).
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
  IF position('seeker_settle_market_list_hero' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  ELSIF r.action=''market_list_item'' THEN\n',
      E'  ELSIF r.action=''market_list_item'' AND r.context->>''kind''=''hero_listing'' THEN\n'
      || E'   v_result:=public.seeker_settle_market_list_hero(p_player,p_key,r.params->>''item_id'',(r.params->>''price'')::bigint);\n'
      || E'  ELSIF r.action=''market_list_item'' THEN\n');
    v_new := replace(v_new, $old$IF v_code NOT IN ('hero_capacity_exceeded',$old$,
      $new$IF v_code NOT IN ('hero_capacity_exceeded','hero_not_found','last_hero','hero_locked','hero_in_team','hero_in_training','hero_has_equipment','market_hero_limit_reached','invalid_market_price',$new$);
    IF v_new = v_def OR position('market_hero_limit_reached' IN v_new) = 0 THEN RAISE EXCEPTION 'seeker_player_hero_market_deliver_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Cancel: a hero listing returns the hero to the roster.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.market_cancel_listing(uuid,uuid,uuid)'::regprocedure);
  IF position('seeker_settle_market_cancel_hero' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  RETURN public.settle_market_cancel(p_player_id, p_idempotency_key, p_listing_id);',
      E'  IF EXISTS (SELECT 1 FROM public.market_hero_listings WHERE id = p_listing_id) THEN\n'
      || E'    RETURN public.seeker_settle_market_cancel_hero(p_player_id, p_idempotency_key, p_listing_id);\n'
      || E'  END IF;\n'
      || E'  RETURN public.settle_market_cancel(p_player_id, p_idempotency_key, p_listing_id);');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_player_hero_market_cancel_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

COMMIT;
