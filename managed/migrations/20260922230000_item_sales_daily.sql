-- Daily item-sales summary kept permanently so detail can expire: counts and
-- value per Moscow day and channel. Weekly and 30-day figures are sums of days.
-- Salvage detail (item_mutation_events) is class D and expires within a day, so
-- the rollup must run before that; Marketplace history is still class A.
CREATE TABLE public.item_sales_daily (
  day date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('salvage_gold', 'market_hero')),
  items integer NOT NULL DEFAULT 0 CHECK (items >= 0),
  gold_total bigint NOT NULL DEFAULT 0 CHECK (gold_total >= 0),
  hero_total numeric NOT NULL DEFAULT 0 CHECK (hero_total >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, channel)
);

ALTER TABLE public.item_sales_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.item_sales_daily FROM PUBLIC, anon, authenticated, service_role;

-- Recomputes one day from the surviving detail; safe to re-run.
CREATE FUNCTION public.rollup_item_sales_daily(p_day date)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_salvage_items integer := 0;
  v_salvage_gold bigint := 0;
  v_market_items integer := 0;
  v_market_hero numeric := 0;
BEGIN
  IF p_day IS NULL THEN RAISE EXCEPTION 'invalid_day'; END IF;

  SELECT COALESCE(sum(jsonb_array_length(event.result->'item_ids')), 0)::integer,
    COALESCE(sum((event.result->>'gold_refund')::bigint), 0)
  INTO v_salvage_items, v_salvage_gold
  FROM public.item_mutation_events event
  WHERE event.action_kind = 'sell'
    AND (event.created_at AT TIME ZONE 'Europe/Moscow')::date = p_day
    AND jsonb_typeof(event.result->'item_ids') = 'array';

  SELECT count(*)::integer, COALESCE(sum(listing.price), 0)
  INTO v_market_items, v_market_hero
  FROM public.market_item_listings listing
  WHERE listing.status = 'sold'
    AND listing.completed_at IS NOT NULL
    AND (listing.completed_at AT TIME ZONE 'Europe/Moscow')::date = p_day;

  INSERT INTO public.item_sales_daily(day, channel, items, gold_total, hero_total)
  VALUES (p_day, 'salvage_gold', v_salvage_items, v_salvage_gold, 0),
    (p_day, 'market_hero', v_market_items, 0, v_market_hero)
  ON CONFLICT (day, channel) DO UPDATE SET
    items = EXCLUDED.items,
    gold_total = EXCLUDED.gold_total,
    hero_total = EXCLUDED.hero_total,
    updated_at = now();

  RETURN jsonb_build_object(
    'day', p_day,
    'salvage_items', v_salvage_items, 'salvage_gold', v_salvage_gold,
    'market_items', v_market_items, 'market_hero', v_market_hero
  );
END
$$;

REVOKE ALL ON FUNCTION public.rollup_item_sales_daily(date) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.rollup_item_sales_daily(date) IS
  'Operator only. Recomputes one Moscow day of item-sales totals; run daily before class D salvage detail expires.';
