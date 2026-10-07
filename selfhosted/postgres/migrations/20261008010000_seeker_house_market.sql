-- Seeker house Market (Founder decision 2026-10-07): game-owned merchant accounts list
-- server-rolled equipment so the Market has real supply. Their sales are marked
-- `house_seller` in the SKR purchase context; the private wallet routes the whole
-- payment to the `fees` treasury account instead of a player wallet.
-- Merchants never sign in (no identity), stay out of Ranks and out of the market
-- risk signals. Seeding is an explicit one-off call of seeker_house_market_seed().
BEGIN;

CREATE TABLE IF NOT EXISTS public.seeker_house_sellers (
  player_id uuid PRIMARY KEY REFERENCES public.players(player_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.seeker_house_market_seeds (
  seed text PRIMARY KEY CHECK (seed ~ '^[a-z0-9-]{3,64}$'),
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.seeker_house_sellers, public.seeker_house_market_seeds FROM PUBLIC, anon, authenticated;

-- The purchase context tells the wallet that the seller is the house.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.seeker_purchase_prepare(uuid,uuid,text,jsonb)'::regprocedure);
  IF position('house_seller' IN v_def) = 0 THEN
    v_new := replace(v_def,
      $old$v_context:=v_context||jsonb_build_object('seller_id',v_listing.seller_id);$old$,
      $new$v_context:=v_context||jsonb_build_object('seller_id',v_listing.seller_id)
    ||CASE WHEN EXISTS (SELECT 1 FROM public.seeker_house_sellers h WHERE h.player_id=v_listing.seller_id)
      THEN jsonb_build_object('house_seller',true) ELSE '{}'::jsonb END;$new$);
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_house_market_prepare_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- Merchants are not players: keep them out of Ranks.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('heroloop_api.leaderboard(uuid)'::regprocedure);
  IF position('seeker_house_sellers' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'    FROM public.players player\n    ORDER BY',
      E'    FROM public.players player\n    WHERE NOT EXISTS (SELECT 1 FROM public.seeker_house_sellers h WHERE h.player_id = player.player_id)\n    ORDER BY');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_house_market_leaderboard_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- House prices are set by the game, not negotiated between accounts: they never
-- feed the rarity medians or the funnel/paired-trading signals.
DO $$
DECLARE v_proc regprocedure; v_def text; v_new text;
BEGIN
  SELECT p.oid::regprocedure INTO v_proc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'account_risk_detector_signals';
  IF v_proc IS NULL THEN RETURN; END IF;
  v_def := pg_get_functiondef(v_proc);
  IF position('seeker_house_sellers' IN v_def) = 0 THEN
    v_new := replace(v_def,
      E'    WHERE m.status = ''sold'' AND m.buyer_id IS NOT NULL\n',
      E'    WHERE m.status = ''sold'' AND m.buyer_id IS NOT NULL\n      AND NOT EXISTS (SELECT 1 FROM public.seeker_house_sellers h WHERE h.player_id = m.seller_id)\n');
    IF v_new = v_def THEN RAISE EXCEPTION 'seeker_house_market_risk_patch_failed'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- One-off supply: p_items server-rolled items (roll v5, the same primitives as chests and
-- Enchant) spread over the named merchants, listed at low USD-cent prices with
-- creation times over the last three days. Re-running a seed tag returns its summary.
CREATE OR REPLACE FUNCTION public.seeker_house_market_seed(p_seed text, p_merchants text[], p_items integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing jsonb;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_name text;
  v_rarities text[] := ARRAY['common','uncommon','rare','epic','legendary','mythic'];
  v_weights numeric[] := ARRAY[32,26,20,13,6.5,2.5];
  v_level_lo integer[] := ARRAY[1,3,6,10,15,20];
  v_level_hi integer[] := ARRAY[15,22,30,38,45,50];
  v_price_lo integer[] := ARRAY[1,2,4,8,18,35];
  v_price_hi integer[] := ARRAY[3,5,10,20,40,60];
  v_classes text[] := ARRAY['mage','assassin','warrior','druid','crossbowman'];
  v_r numeric; v_cursor numeric; v_index integer; v_rarity text; v_catalog integer;
  v_slot text; v_base text; v_level integer; v_enchant integer; v_stats jsonb; v_power numeric;
  v_price integer; v_item uuid; v_at timestamptz; v_counts jsonb := '{}'::jsonb; v_summary jsonb; i integer;
BEGIN
  IF p_seed IS NULL OR p_seed !~ '^[a-z0-9-]{3,64}$' OR p_items NOT BETWEEN 1 AND 2000
     OR cardinality(p_merchants) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_house_market_seed';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('seeker-house-market-seed', 0));
  SELECT summary INTO v_existing FROM public.seeker_house_market_seeds WHERE seed = p_seed;
  IF FOUND THEN RETURN v_existing; END IF;

  FOREACH v_name IN ARRAY p_merchants LOOP
    IF v_name IS NULL OR length(v_name) NOT BETWEEN 3 AND 32 THEN RAISE EXCEPTION 'invalid_house_merchant_name'; END IF;
    v_id := md5('seeker-house-seller:' || lower(v_name))::uuid;
    INSERT INTO auth.users(instance_id, id, aud, role, created_at, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', now(), now())
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.players(player_id, username, token_eligible) VALUES (v_id, v_name, false)
      ON CONFLICT (player_id) DO NOTHING;
    INSERT INTO public.player_saves(player_id, state, revision)
      VALUES (v_id, jsonb_build_object('username', v_name, 'inventory', '[]'::jsonb, 'ownedHeroes', '[]'::jsonb,
        'chests', '[]'::jsonb, 'team', '[]'::jsonb, 'bagSlots', '[48,0,0,0]'::jsonb), 1)
      ON CONFLICT (player_id) DO NOTHING;
    INSERT INTO public.seeker_house_sellers(player_id) VALUES (v_id) ON CONFLICT DO NOTHING;
    v_ids := v_ids || v_id;
  END LOOP;

  FOR i IN 1..p_items LOOP
    v_r := random() * 100; v_cursor := 0; v_index := 1;
    FOR j IN 1..6 LOOP v_cursor := v_cursor + v_weights[j]; IF v_r <= v_cursor THEN v_index := j; EXIT; END IF; END LOOP;
    v_rarity := v_rarities[v_index];
    v_catalog := floor(random() * 16)::integer;
    IF v_catalog < 5 THEN
      v_slot := 'class_weapon'; v_base := 'weapon-' || v_classes[v_catalog + 1] || '-' || v_rarity;
    ELSIF v_catalog < 10 THEN
      v_slot := 'offhand'; v_base := 'offhand-' || v_classes[v_catalog - 4] || '-' || v_rarity;
    ELSE
      v_slot := (ARRAY['helmet','chest','gloves','boots','amulet','ring'])[v_catalog - 9];
      v_base := (ARRAY['helmet','armor','gloves','boots','amulet','ring'])[v_catalog - 9] || '-' || v_rarity;
    END IF;
    v_level := v_level_lo[v_index] + floor(random() * (v_level_hi[v_index] - v_level_lo[v_index] + 1))::integer;
    v_r := random();
    v_enchant := CASE WHEN v_r < 0.74 THEN 0 WHEN v_r < 0.86 THEN 1 + floor(random() * 2)::integer
      WHEN v_r < 0.94 THEN 3 + floor(random() * 3)::integer ELSE 6 + floor(random() * 4)::integer END;
    v_stats := public.roll_item_stats_v5(v_slot, v_rarity, v_level, v_base);
    -- Same power formulas as a fresh chest item and as a successful Enchant.
    v_power := CASE WHEN v_enchant = 0 THEN public.calculate_item_power_v5(v_stats, 0)
      ELSE public.calculate_item_power_v4(v_stats, v_enchant) END;
    v_price := v_price_lo[v_index] + floor(random() * (v_price_hi[v_index] - v_price_lo[v_index] + 1))::integer
      + round(v_enchant * v_price_lo[v_index] * 0.4)::integer + v_level / 15;
    v_item := gen_random_uuid();
    v_at := now() - random() * interval '72 hours';
    v_id := v_ids[1 + floor(random() * cardinality(v_ids))::integer];
    INSERT INTO public.player_items(id, player_id, base_item_id, slot, rarity, item_level, stats, power, locked,
      reroll_count, enchant_level, enchant_stats_version, item_roll_version, source_kind, created_at)
      VALUES (v_item, v_id, v_base, v_slot, v_rarity, v_level, v_stats, v_power, false,
      0, v_enchant, 4, 5, 'house_market', v_at);
    INSERT INTO public.market_item_listings(item_id, seller_id, price, created_at)
      VALUES (v_item, v_id, LEAST(80, GREATEST(1, v_price)), v_at + interval '1 minute');
    v_counts := jsonb_set(v_counts, ARRAY[v_rarity], to_jsonb(COALESCE((v_counts->>v_rarity)::integer, 0) + 1), true);
  END LOOP;

  v_summary := jsonb_build_object('seed', p_seed, 'merchants', cardinality(v_ids), 'items', p_items, 'rarities', v_counts);
  INSERT INTO public.seeker_house_market_seeds(seed, summary) VALUES (p_seed, v_summary);
  RETURN v_summary;
END $$;
REVOKE ALL ON FUNCTION public.seeker_house_market_seed(text, text[], integer) FROM PUBLIC, anon, authenticated;

COMMIT;
