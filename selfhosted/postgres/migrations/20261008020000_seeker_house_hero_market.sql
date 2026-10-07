-- Seeker house Market heroes (Founder decision 2026-10-08): the game-owned merchants of
-- 20261008010000 also list heroes. A hero listing holds the hero snapshot (catalogue id,
-- level, stars); buying uses the same SKR product `market_buy_listing`, is quoted with
-- `kind: hero`, checks the buyer's hero capacity before payment and adds a fresh hero to
-- the buyer's roster on delivery. House payments go to the fees treasury (wallet side).
-- Player-to-player hero listings are a later feature.
BEGIN;

CREATE TABLE IF NOT EXISTS public.market_hero_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.players(player_id) ON DELETE CASCADE,
  hero jsonb NOT NULL CHECK (jsonb_typeof(hero) = 'object' AND hero ? 'heroId'),
  price bigint NOT NULL CHECK (price BETWEEN 1 AND 1000000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled')),
  buyer_id uuid REFERENCES public.players(player_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS market_hero_listings_active ON public.market_hero_listings(created_at DESC) WHERE status = 'active';
REVOKE ALL ON public.market_hero_listings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.market_hero_listings_json(p_player_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', l.id, 'price', l.price, 'seller_id', l.seller_id, 'seller', COALESCE(p.username, 'Player'),
    'is_own', l.seller_id = p_player_id, 'created_at', l.created_at,
    'hero', jsonb_build_object('heroId', l.hero->>'heroId', 'level', (l.hero->>'level')::integer, 'stars', (l.hero->>'stars')::integer)
  ) ORDER BY l.created_at DESC), '[]'::jsonb)
  FROM public.market_hero_listings l LEFT JOIN public.players p ON p.player_id = l.seller_id
  WHERE l.status = 'active'
$$;
REVOKE ALL ON FUNCTION public.market_hero_listings_json(uuid) FROM PUBLIC, anon, authenticated;

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
    'equipped', '{}'::jsonb, 'xp', 0, 'isNew', true);
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

-- Quote: a listing id that is not an item listing may be a hero listing.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('market_hero_listings' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$  SELECT * INTO v_listing FROM public.market_item_listings WHERE id=(p_params->>'listing_id')::uuid AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;$old$,
      $new$  SELECT * INTO v_listing FROM public.market_item_listings WHERE id=(p_params->>'listing_id')::uuid AND status='active';
  IF NOT FOUND THEN
   SELECT h.id,h.id,h.seller_id,NULL::uuid,h.price,h.status,h.created_at,NULL::timestamptz INTO v_listing
    FROM public.market_hero_listings h WHERE h.id=(p_params->>'listing_id')::uuid AND h.status='active';
   IF NOT FOUND THEN RAISE EXCEPTION 'market_listing_unavailable'; END IF;
   SELECT state INTO v_state FROM public.player_saves WHERE player_id=p_player;
   IF v_state IS NULL THEN RAISE EXCEPTION 'save_not_found'; END IF;
   IF jsonb_array_length(COALESCE(v_state->'ownedHeroes','[]'::jsonb))+1>COALESCE((v_state->>'heroCapacity')::integer,500) THEN RAISE EXCEPTION 'hero_capacity_exceeded'; END IF;
   v_context:=v_context||jsonb_build_object('kind','hero');
  END IF;$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_hero_market_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Delivery: the hero listing must still match the prepared seller and price.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_deliver(uuid,uuid)'::regprocedure);
  IF position('seeker_settle_market_buy_hero' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'  ELSIF r.action=''market_buy_listing'' THEN\n',
      E'  ELSIF r.action=''market_buy_listing'' AND r.context->>''kind''=''hero'' THEN\n'
      || E'   IF public.account_risk_level((r.context->>''seller_id'')::uuid) IN (''review'',''hold'') THEN RAISE EXCEPTION ''market_listing_unavailable''; END IF;\n'
      || E'   PERFORM 1 FROM public.market_hero_listings WHERE id=(r.params->>''listing_id'')::uuid\n'
      || E'    AND seller_id=(r.context->>''seller_id'')::uuid AND price=r.usd_cents AND status=''active'' FOR UPDATE;\n'
      || E'   IF NOT FOUND THEN RAISE EXCEPTION ''market_listing_unavailable''; END IF;\n'
      || E'   v_result:=public.seeker_settle_market_buy_hero(p_player,(r.params->>''listing_id'')::uuid);\n'
      || E'  ELSIF r.action=''market_buy_listing'' THEN\n');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_hero_market_deliver_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Snapshot: hero listings beside item listings.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.market_snapshot(uuid)'::regprocedure);
  IF position('hero_listings' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$RETURN jsonb_build_object('listings', v_listings,$old$,
      $new$RETURN jsonb_build_object('hero_listings', public.market_hero_listings_json(p_player_id), 'listings', v_listings,$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_hero_market_snapshot_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- One-off hero supply over the existing house merchants (seed tags are shared with items).
CREATE OR REPLACE FUNCTION public.seeker_house_hero_market_seed(p_seed text, p_heroes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing jsonb; v_ids uuid[];
  v_rarities text[] := ARRAY['common','uncommon','rare','epic','legendary','mythic'];
  v_weights numeric[] := ARRAY[30,27,20,13,7,3];
  v_price_lo integer[] := ARRAY[2,4,8,15,35,70];
  v_price_hi integer[] := ARRAY[5,9,18,35,70,120];
  v_classes text[] := ARRAY['shepherd','assassin','knight','druid','archer'];
  v_r numeric; v_cursor numeric; v_index integer; v_level integer; v_stars integer; v_price integer;
  v_counts jsonb := '{}'::jsonb; v_summary jsonb; v_rarity text; i integer;
BEGIN
  IF p_seed IS NULL OR p_seed !~ '^[a-z0-9-]{3,64}$' OR p_heroes NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_house_market_seed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('seeker-house-market-seed', 0));
  SELECT summary INTO v_existing FROM public.seeker_house_market_seeds WHERE seed = p_seed;
  IF FOUND THEN RETURN v_existing; END IF;
  SELECT array_agg(player_id ORDER BY player_id) INTO v_ids FROM public.seeker_house_sellers;
  IF v_ids IS NULL THEN RAISE EXCEPTION 'house_merchants_missing'; END IF;
  FOR i IN 1..p_heroes LOOP
    v_r := random() * 100; v_cursor := 0; v_index := 1;
    FOR j IN 1..6 LOOP v_cursor := v_cursor + v_weights[j]; IF v_r <= v_cursor THEN v_index := j; EXIT; END IF; END LOOP;
    v_rarity := v_rarities[v_index];
    -- Mostly fresh heroes: low levels, no stars; a minority trained and starred.
    v_r := random();
    v_level := CASE WHEN v_r < 0.55 THEN 1 + floor(random() * 5)::integer
      WHEN v_r < 0.85 THEN 5 + floor(random() * 11)::integer ELSE 15 + floor(random() * 16)::integer END;
    v_r := random();
    v_stars := CASE WHEN v_r < 0.70 THEN 0 WHEN v_r < 0.85 THEN 1 WHEN v_r < 0.93 THEN 2
      WHEN v_r < 0.98 THEN 3 ELSE 4 + floor(random() * 2)::integer END;
    v_price := v_price_lo[v_index] + floor(random() * (v_price_hi[v_index] - v_price_lo[v_index] + 1))::integer
      + v_stars * v_price_lo[v_index] + v_level / 5;
    INSERT INTO public.market_hero_listings(seller_id, hero, price, created_at)
      VALUES (v_ids[1 + floor(random() * cardinality(v_ids))::integer],
        jsonb_build_object('heroId', v_classes[1 + floor(random() * 5)::integer] || '-' || v_rarity, 'level', v_level, 'stars', v_stars),
        LEAST(150, GREATEST(1, v_price)), now() - random() * interval '72 hours');
    v_counts := jsonb_set(v_counts, ARRAY[v_rarity], to_jsonb(COALESCE((v_counts->>v_rarity)::integer, 0) + 1), true);
  END LOOP;
  v_summary := jsonb_build_object('seed', p_seed, 'heroes', p_heroes, 'merchants', cardinality(v_ids), 'rarities', v_counts);
  INSERT INTO public.seeker_house_market_seeds(seed, summary) VALUES (p_seed, v_summary);
  RETURN v_summary;
END $$;
REVOKE ALL ON FUNCTION public.seeker_house_hero_market_seed(text, integer) FROM PUBLIC, anon, authenticated;

COMMIT;
