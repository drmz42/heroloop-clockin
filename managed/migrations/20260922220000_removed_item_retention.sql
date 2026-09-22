-- Sold, salvaged and destroyed items keep a permanent player_items row today,
-- so a player who opens chests all day leaves rows forever (measured: 96% of
-- rows on Staging are already removed). Keep a per-day summary for anti-cheat
-- and delete the detail after a retention window. Owned items are untouched.
CREATE TABLE public.player_item_history_daily (
  day date NOT NULL,
  player_id uuid NOT NULL,
  rarity text NOT NULL,
  source_kind text NOT NULL,
  removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, player_id, rarity, source_kind)
);

ALTER TABLE public.player_item_history_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.player_item_history_daily FROM PUBLIC, anon, authenticated, service_role;

-- Batched so it never holds a long lock; call it until deleted_rows is 0.
CREATE FUNCTION public.compact_removed_player_items(
  p_before timestamptz,
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_deleted integer := 0;
  v_days integer := 0;
BEGIN
  IF p_before IS NULL OR p_before >= now() THEN RAISE EXCEPTION 'invalid_retention_boundary'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20000 THEN RAISE EXCEPTION 'invalid_batch_limit'; END IF;

  WITH candidate AS (
    SELECT item.id, item.player_id, item.rarity, item.source_kind, item.removed_at
    FROM public.player_items item
    WHERE item.removed_at IS NOT NULL
      AND item.removed_at < p_before
      -- An account under Watch, Review or Hold keeps its full item detail.
      AND public.account_risk_level(item.player_id) = 'normal'
      -- A listing still points at the row it sold.
      AND NOT EXISTS (SELECT 1 FROM public.market_item_listings listing WHERE listing.item_id = item.id)
    ORDER BY item.removed_at
    LIMIT p_limit
    FOR UPDATE OF item SKIP LOCKED
  ), removed AS (
    DELETE FROM public.player_items item
    USING candidate
    WHERE item.id = candidate.id
    RETURNING item.player_id, item.rarity, item.source_kind, item.removed_at
  ), summary AS (
    SELECT (removed.removed_at AT TIME ZONE 'Europe/Moscow')::date AS day,
      removed.player_id, removed.rarity, COALESCE(removed.source_kind, 'unknown') AS source_kind,
      count(*)::integer AS removed_count
    FROM removed
    GROUP BY 1, 2, 3, 4
  ), merged AS (
    INSERT INTO public.player_item_history_daily(day, player_id, rarity, source_kind, removed_count)
    SELECT day, player_id, rarity, source_kind, removed_count FROM summary
    ON CONFLICT (day, player_id, rarity, source_kind) DO UPDATE SET
      removed_count = public.player_item_history_daily.removed_count + EXCLUDED.removed_count,
      updated_at = now()
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM merged), (SELECT COALESCE(sum(removed_count), 0) FROM summary)
  INTO v_days, v_deleted;

  RETURN jsonb_build_object('deleted_rows', COALESCE(v_deleted, 0), 'summary_rows', COALESCE(v_days, 0), 'before', p_before);
END
$$;

REVOKE ALL ON FUNCTION public.compact_removed_player_items(timestamptz, integer)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.compact_removed_player_items(timestamptz, integer) IS
  'Operator only. Deletes removed item rows past the retention window, keeping per-day counts; skips accounts under a risk level and rows a market listing still references.';
