-- Seeker Market Activity and My Listings history include hero and Boss Chest sales
-- (Founder 2026-10-09), not only equipment. Each source is limited before the merge,
-- so a snapshot never scans more than its newest rows. Names: equipment base id,
-- hero catalogue id (the client resolves both) or 'Boss Chest ×<quantity>'.
BEGIN;

CREATE OR REPLACE FUNCTION public.seeker_market_sales_feed(p_player_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', sale.id, 'name', sale.name, 'price', sale.price,
    'createdAt', floor(extract(epoch FROM sale.completed_at) * 1000),
    'action', CASE WHEN p_player_id IS NOT NULL AND sale.buyer_id = p_player_id THEN 'bought' ELSE 'sold' END
  ) ORDER BY sale.completed_at DESC, sale.id DESC), '[]'::jsonb)
  FROM (
    SELECT * FROM (
      (SELECT listing.id, listing.completed_at, COALESCE(item.base_item_id, 'Item') AS name, listing.price, listing.seller_id, listing.buyer_id
        FROM public.market_item_listings listing LEFT JOIN public.player_items item ON item.id = listing.item_id
        WHERE listing.status = 'sold' AND listing.completed_at IS NOT NULL
          AND (p_player_id IS NULL OR listing.seller_id = p_player_id OR listing.buyer_id = p_player_id)
        ORDER BY listing.completed_at DESC, listing.id DESC LIMIT p_limit)
      UNION ALL
      (SELECT hero.id, hero.completed_at, COALESCE(hero.hero->>'heroId', 'Hero'), hero.price, hero.seller_id, hero.buyer_id
        FROM public.market_hero_listings hero
        WHERE hero.status = 'sold' AND hero.completed_at IS NOT NULL
          AND (p_player_id IS NULL OR hero.seller_id = p_player_id OR hero.buyer_id = p_player_id)
        ORDER BY hero.completed_at DESC, hero.id DESC LIMIT p_limit)
      UNION ALL
      (SELECT chest.id, chest.completed_at, 'Boss Chest ×' || chest.quantity, chest.price, chest.seller_id, chest.buyer_id
        FROM public.market_chest_listings chest
        WHERE chest.status = 'sold' AND chest.completed_at IS NOT NULL
          AND (p_player_id IS NULL OR chest.seller_id = p_player_id OR chest.buyer_id = p_player_id)
        ORDER BY chest.completed_at DESC, chest.id DESC LIMIT p_limit)
    ) merged ORDER BY completed_at DESC, id DESC LIMIT p_limit
  ) sale
$$;
REVOKE ALL ON FUNCTION public.seeker_market_sales_feed(uuid, integer) FROM PUBLIC, anon, authenticated;

-- Same snapshot as before; activity and history now come from the merged feed.
CREATE OR REPLACE FUNCTION heroloop_api.seeker_market_snapshot(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.market_snapshot(p_player_id) || jsonb_build_object(
    'fee_percent', 10,
    'activity', public.seeker_market_sales_feed(NULL, 100),
    'history', public.seeker_market_sales_feed(p_player_id, 30)
  );
$$;

COMMIT;
