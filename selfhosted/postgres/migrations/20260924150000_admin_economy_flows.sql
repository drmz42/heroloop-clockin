\set ON_ERROR_STOP on

-- Player-facing economy flows for the Founder Control Center
-- (docs/game/founder-control-center-v2-tz.md, Business Control).
--
-- The Overview row that named Market, Shop, Pity, Summon and Enchant had no
-- source: admin.economy_summary answers in ledger flows and source kinds, which
-- is the accountant's view, not the player's. This function answers the
-- player's view from the systems' own tables, and only in aggregate.
--
-- Three rules hold everywhere below. A table that does not exist reports
-- 'not_tracked' and an empty one reports 'no_events'; neither is ever shown as
-- a zero that looks measured. A distinct-player count below the threshold is
-- withheld, so a flow used by one person cannot become a way to notice that
-- person. And nothing here selects a player_id into the result.

CREATE OR REPLACE FUNCTION admin.economy_flows(p_window_hours integer DEFAULT 24)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  -- Clamped rather than trusted: an unbounded window would turn a dashboard
  -- refresh into a full-table scan.
  v_hours integer := least(greatest(coalesce(p_window_hours, 24), 1), 720);
  v_since timestamptz := now() - make_interval(hours => v_hours);
  v_min integer := 5;
  v_summon jsonb;
  v_pity jsonb;
  v_market jsonb;
  v_listings jsonb;
  v_flows jsonb;
  v_shop jsonb;
  -- Treasury inflows that belong to a system named below. Anything else is a
  -- shop purchase, which has no table of its own; the kinds are returned with
  -- the group so the grouping stays inspectable instead of being trusted.
  v_named text[] := ARRAY['hero-summon', 'item-enchant', 'enchant-charm', 'item-reroll', 'hero-ascension'];
BEGIN
  IF to_regclass('public.summon_events') IS NULL THEN
    v_summon := jsonb_build_object('state', 'not_tracked');
    v_pity := jsonb_build_object('state', 'not_tracked');
  ELSE
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'events', count(*),
      'players', CASE WHEN count(DISTINCT player_id) >= v_min THEN count(DISTINCT player_id) END,
      'players_suppressed', count(DISTINCT player_id) BETWEEN 1 AND v_min - 1,
      'heroes_summoned', coalesce(sum(summon_count), 0),
      'tokens_spent', round(coalesce(sum(token_cost), 0), 2),
      'scrolls_spent', coalesce(sum(coalesce(scroll_cost, 0)), 0)
    ) INTO v_summon
    FROM public.summon_events WHERE created_at >= v_since;

    -- Pity counters are the state the server wrote after each summon, so the
    -- honest aggregate over a window is how high they ran, not a per-player
    -- standing. A tier missing from the payload is absent, not zero.
    SELECT coalesce(jsonb_object_agg(tier, jsonb_build_object('max', high, 'avg', mean)), '{}'::jsonb)
    INTO v_pity
    FROM (
      SELECT t.tier,
             max((e.result ->> t.tier)::numeric) AS high,
             round(avg((e.result ->> t.tier)::numeric), 1) AS mean
      FROM public.summon_events e
      CROSS JOIN unnest(ARRAY['pity_legendary', 'pity_mythic', 'pity_divine', 'pity_celestial', 'pity_cosmic']) AS t(tier)
      WHERE e.created_at >= v_since
        AND jsonb_typeof(e.result -> t.tier) = 'number'
      GROUP BY t.tier
    ) pity;
    IF v_pity = '{}'::jsonb THEN v_pity := jsonb_build_object('state', 'no_events'); END IF;
  END IF;

  IF to_regclass('public.market_item_events') IS NULL THEN
    v_market := jsonb_build_object('state', 'not_tracked');
  ELSE
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'events', count(*),
      'players', CASE WHEN count(DISTINCT player_id) >= v_min THEN count(DISTINCT player_id) END,
      'players_suppressed', count(DISTINCT player_id) BETWEEN 1 AND v_min - 1,
      'by_action', coalesce((
        SELECT jsonb_object_agg(action, entries)
        FROM (SELECT action, count(*) AS entries FROM public.market_item_events WHERE created_at >= v_since GROUP BY action) a
      ), '{}'::jsonb)
    ) INTO v_market
    FROM public.market_item_events WHERE created_at >= v_since;
  END IF;

  IF to_regclass('public.market_item_listings') IS NULL THEN
    v_listings := jsonb_build_object('state', 'not_tracked');
  ELSE
    SELECT jsonb_build_object(
      'state', CASE WHEN count(*) = 0 THEN 'no_events' ELSE 'connected' END,
      'by_status', coalesce((
        SELECT jsonb_object_agg(status, entries)
        FROM (SELECT status, count(*) AS entries FROM public.market_item_listings GROUP BY status) s
      ), '{}'::jsonb)
    ) INTO v_listings
    FROM public.market_item_listings;
  END IF;

  -- Enchant, reroll and ascension have no tables of their own: the treasury
  -- inflow the server writes when the charge succeeds is the event.
  SELECT coalesce(jsonb_object_agg(flow_key, jsonb_build_object(
      'state', 'connected', 'entries', entries, 'tokens', tokens,
      'players', CASE WHEN players >= v_min THEN players END,
      'players_suppressed', players BETWEEN 1 AND v_min - 1
    )), '{}'::jsonb)
  INTO v_flows
  FROM (
    SELECT CASE source_kind
             WHEN 'item-enchant' THEN 'enchant'
             WHEN 'enchant-charm' THEN 'enchant'
             WHEN 'item-reroll' THEN 'reroll'
             WHEN 'hero-ascension' THEN 'ascension'
             WHEN 'hero-summon' THEN 'summon_charge'
           END AS flow_key,
           count(*) AS entries,
           round(sum(amount), 2) AS tokens,
           count(DISTINCT player_id) AS players
    FROM public.hero_economy_ledger
    WHERE occurred_at >= v_since AND flow = 'treasury_inflow' AND source_kind = ANY(v_named)
    GROUP BY 1
  ) named;

  SELECT jsonb_build_object(
    'state', CASE WHEN coalesce(sum(entries), 0) = 0 THEN 'no_events' ELSE 'connected' END,
    'entries', coalesce(sum(entries), 0),
    'tokens', round(coalesce(sum(tokens), 0), 2),
    'source_kinds', coalesce(jsonb_agg(source_kind ORDER BY source_kind) FILTER (WHERE source_kind IS NOT NULL), '[]'::jsonb)
  ) INTO v_shop
  FROM (
    SELECT source_kind, count(*) AS entries, sum(amount) AS tokens
    FROM public.hero_economy_ledger
    WHERE occurred_at >= v_since AND flow = 'treasury_inflow' AND NOT (source_kind = ANY(v_named))
    GROUP BY source_kind
  ) shop;

  RETURN jsonb_build_object(
    'version', 'economy-flows.v1',
    'as_of', now(),
    'window_hours', v_hours,
    'min_cohort', v_min,
    'summon', v_summon,
    'pity', v_pity,
    'market', v_market,
    'market_listings', v_listings,
    'charges', v_flows,
    'shop', v_shop
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.economy_flows(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.economy_flows(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.economy_flows(integer) IS
  'Aggregate-only player-facing economy flows for the Founder Control Center: summon, pity, Market, shop and per-system charges over a clamped window, with small-cohort suppression; never a per-player row, never a write.';
