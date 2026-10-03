-- Read-only Seeker feed; never expose trader identities or modify settlement.
CREATE INDEX IF NOT EXISTS market_item_listings_sold_completed
  ON public.market_item_listings(completed_at DESC, id DESC) WHERE status = 'sold';

CREATE OR REPLACE FUNCTION heroloop_api.seeker_market_snapshot(p_player_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.market_snapshot(p_player_id) || jsonb_build_object(
    'activity', COALESCE((
      SELECT jsonb_agg(entry ORDER BY completed_at DESC, id DESC)
      FROM (
        SELECT listing.id, listing.completed_at, jsonb_build_object(
          'id', listing.id,
          'name', COALESCE(item.base_item_id, 'Item'),
          'price', listing.price,
          'createdAt', floor(extract(epoch FROM listing.completed_at) * 1000),
          'action', 'sold'
        ) AS entry
        FROM public.market_item_listings listing
        LEFT JOIN public.player_items item ON item.id = listing.item_id
        WHERE listing.status = 'sold' AND listing.completed_at IS NOT NULL
        ORDER BY listing.completed_at DESC, listing.id DESC
        LIMIT 100
      ) sales
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION heroloop_api.seeker_market_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.seeker_market_snapshot(uuid) TO heroloop_api;
