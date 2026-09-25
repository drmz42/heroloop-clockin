\set ON_ERROR_STOP on

-- Tokenomics read model for the Founder Control Center
-- (HL-TASK-20260924112430-CEC31A, docs/game/founder-control-center-v2-tz.md,
-- docs/game/tokenomics-and-earn-proposal.md).
--
-- How much $HERO the fixed pool is meant to emit and how much it did, day by
-- day; where the emitted $HERO sits, as holding bands and concentration; which
-- faucets and sinks moved it; and how much of the emission came back as spend.
-- Aggregates only: no row here names or points at a player. Holding bands are
-- merged until each holds five or more players, and a concentration
-- share is only computed once enough holders exist that it cannot describe one
-- person's wallet.
--
-- Nothing here writes. Changing the pool, a fee or a reward budget is a live
-- economy change behind Founder approval, and the panel has no path to it.

CREATE OR REPLACE FUNCTION admin.tokenomics_summary(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  -- Clamped rather than trusted: an unbounded range turns a refresh into a
  -- full-table scan.
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from date := (now() AT TIME ZONE 'UTC')::date - (v_days - 1);
  v_since timestamptz := ((now() AT TIME ZONE 'UTC')::date - (v_days - 1))::timestamp AT TIME ZONE 'UTC';
  v_pool jsonb := NULL;
  v_emission jsonb := '[]'::jsonb;
  v_ledger_days jsonb;
  v_holders integer;
  v_held numeric;
  v_bands jsonb;
  v_band record;
  v_last jsonb;
  v_group_n integer := 0;
  v_group_amount numeric := 0;
  v_group_low numeric;
  v_group_high numeric;
  v_top10 numeric := NULL;
  v_top1 numeric := NULL;
  v_gini numeric := NULL;
  v_faucets jsonb;
  v_sinks jsonb;
  v_issued numeric;
  v_returned numeric;
BEGIN
  -- The fixed pool and its running total. The tables belong to the worker
  -- migrations, so a database without them reports not tracked rather than 0.
  IF to_regclass('public.token_pool') IS NOT NULL THEN
    EXECUTE $q$
      SELECT jsonb_build_object(
        'daily_pool', pool_amount,
        'total_distributed', round(total_distributed, 2),
        'updated_at', updated_at)
      FROM public.token_pool ORDER BY id LIMIT 1
    $q$ INTO v_pool;
  END IF;

  IF to_regclass('public.distribution_log') IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'day', to_char(day, 'YYYY-MM-DD'),
          'distributed', round(distributed, 2),
          'forfeited', round(forfeited, 2),
          'ticks', ticks,
          'players_peak', players_peak) ORDER BY day), '[]'::jsonb)
      FROM (
        SELECT (tick_at AT TIME ZONE 'UTC')::date AS day,
               sum(amount_distributed) AS distributed,
               sum(coalesce(forfeited, 0)) AS forfeited,
               count(*) AS ticks,
               max(player_count) AS players_peak
        FROM public.distribution_log
        WHERE tick_at >= $1
        GROUP BY 1
      ) daily
    $q$ INTO v_emission USING v_since;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'day', to_char(day, 'YYYY-MM-DD'),
      'issued', round(issued, 2),
      'returned', round(returned, 2)) ORDER BY day), '[]'::jsonb)
  INTO v_ledger_days
  FROM (
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
           coalesce(sum(amount) FILTER (WHERE flow = 'player_issuance'), 0) AS issued,
           coalesce(sum(amount) FILTER (WHERE flow = 'treasury_inflow'), 0) AS returned
    FROM public.hero_economy_ledger
    WHERE occurred_at >= v_since
    GROUP BY 1
  ) daily;

  -- Holdings: what a player has on the balance plus what is accrued and not yet
  -- claimed, because both are $HERO the pool has already let go of.
  SELECT count(*), coalesce(sum(held), 0) INTO v_holders, v_held FROM (SELECT coalesce(token_balance, 0) + coalesce(pending_tokens, 0) AS held FROM public.players WHERE coalesce(token_balance, 0) + coalesce(pending_tokens, 0) > 0) holdings;

  -- Holding bands. A band with one to four holders would describe those few
  -- wallets, and withholding it alone would not help: the total minus the
  -- visible bands gives it back. So a small band is merged with its neighbours
  -- until every published band holds five or more, and a remainder too small to
  -- stand alone joins the band before it.
  v_bands := '[]'::jsonb;
  FOR v_band IN
    SELECT band.low, band.high, count(holdings.held) AS n, coalesce(sum(holdings.held), 0) AS amount
    FROM (VALUES (0::numeric, 100::numeric), (100, 1000), (1000, 10000), (10000, 100000), (100000, NULL)) AS band(low, high)
    LEFT JOIN (SELECT coalesce(token_balance, 0) + coalesce(pending_tokens, 0) AS held FROM public.players WHERE coalesce(token_balance, 0) + coalesce(pending_tokens, 0) > 0) holdings
      ON holdings.held > band.low AND (band.high IS NULL OR holdings.held <= band.high)
    GROUP BY band.low, band.high
    ORDER BY band.low
  LOOP
    IF v_group_n = 0 THEN v_group_low := v_band.low; END IF;
    v_group_n := v_group_n + v_band.n;
    v_group_amount := v_group_amount + v_band.amount;
    v_group_high := v_band.high;
    IF v_group_n >= 5 THEN
      v_bands := v_bands || jsonb_build_array(jsonb_build_object(
        'min', v_group_low, 'max', v_group_high, 'holders', v_group_n, 'amount', round(v_group_amount, 2)));
      v_group_n := 0;
      v_group_amount := 0;
    END IF;
  END LOOP;
  IF v_group_n > 0 THEN
    IF jsonb_array_length(v_bands) > 0 THEN
      v_last := v_bands -> -1;
      v_bands := (v_bands - (jsonb_array_length(v_bands) - 1)) || jsonb_build_array(jsonb_build_object(
        'min', v_last->'min', 'max', v_group_high,
        'holders', (v_last->>'holders')::integer + v_group_n,
        'amount', round((v_last->>'amount')::numeric + v_group_amount, 2)));
    ELSE
      -- Fewer than five holders in all: there is no band that is not a wallet.
      v_bands := jsonb_build_array(jsonb_build_object('min', 0, 'max', NULL, 'holders', NULL, 'amount', NULL, 'withheld', true));
    END IF;
  END IF;

  -- Top 10% needs at least twenty holders and top 1% at least five hundred, so
  -- the share always covers two or more wallets.
  IF v_held > 0 AND v_holders >= 20 THEN
    SELECT round(100 * sum(held) / v_held, 1) INTO v_top10
    FROM (SELECT held FROM (SELECT coalesce(token_balance, 0) + coalesce(pending_tokens, 0) AS held FROM public.players WHERE coalesce(token_balance, 0) + coalesce(pending_tokens, 0) > 0) holdings ORDER BY held DESC LIMIT ceil(v_holders * 0.10)::integer) top;
  END IF;
  IF v_held > 0 AND v_holders >= 500 THEN
    SELECT round(100 * sum(held) / v_held, 1) INTO v_top1
    FROM (SELECT held FROM (SELECT coalesce(token_balance, 0) + coalesce(pending_tokens, 0) AS held FROM public.players WHERE coalesce(token_balance, 0) + coalesce(pending_tokens, 0) > 0) holdings ORDER BY held DESC LIMIT ceil(v_holders * 0.01)::integer) top;
  END IF;
  -- Gini over holders: 0 is perfectly even, 1 is one wallet holding it all.
  IF v_held > 0 AND v_holders >= 5 THEN
    SELECT round((2 * sum(rank * held) / (v_holders * sum(held)) - (v_holders + 1)::numeric / v_holders), 3)
    INTO v_gini
    FROM (SELECT held, row_number() OVER (ORDER BY held) AS rank FROM (SELECT coalesce(token_balance, 0) + coalesce(pending_tokens, 0) AS held FROM public.players WHERE coalesce(token_balance, 0) + coalesce(pending_tokens, 0) > 0) holdings) ranked;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('source_kind', source_kind, 'entries', entries, 'amount', round(amount, 2))
      ORDER BY amount DESC), '[]'::jsonb)
  INTO v_faucets
  FROM (SELECT source_kind, count(*) AS entries, sum(amount) AS amount
        FROM public.hero_economy_ledger
        WHERE flow = 'player_issuance' AND occurred_at >= v_since GROUP BY 1) faucets;

  SELECT coalesce(jsonb_agg(jsonb_build_object('source_kind', source_kind, 'entries', entries, 'amount', round(amount, 2))
      ORDER BY amount DESC), '[]'::jsonb)
  INTO v_sinks
  FROM (SELECT source_kind, count(*) AS entries, sum(amount) AS amount
        FROM public.hero_economy_ledger
        WHERE flow = 'treasury_inflow' AND occurred_at >= v_since GROUP BY 1) sinks;

  SELECT coalesce(sum(amount) FILTER (WHERE flow = 'player_issuance'), 0),
         coalesce(sum(amount) FILTER (WHERE flow = 'treasury_inflow'), 0)
  INTO v_issued, v_returned
  FROM public.hero_economy_ledger WHERE occurred_at >= v_since;

  RETURN jsonb_build_object(
    'version', 'tokenomics.v1',
    'as_of', now(),
    'timezone', 'UTC',
    'days', v_days,
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'pool', v_pool,
    'emission_days', v_emission,
    'ledger_days', v_ledger_days,
    'holdings', jsonb_build_object(
      'holders', v_holders,
      'held_total', round(v_held, 2),
      'bands', coalesce(v_bands, '[]'::jsonb),
      'top10_share_percent', v_top10,
      'top1_share_percent', v_top1,
      'gini', v_gini),
    'faucets', v_faucets,
    'sinks', v_sinks,
    'window', jsonb_build_object(
      'issued', round(v_issued, 2),
      'returned', round(v_returned, 2),
      -- The proposal's Self-Funding Ratio, measured on the ledger: how much of
      -- what players received came back through spend in the same window.
      'self_funding_percent', CASE WHEN v_issued > 0 THEN round(100 * v_returned / v_issued, 1) END)
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.tokenomics_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.tokenomics_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.tokenomics_summary(integer) IS
  'Aggregate-only tokenomics read for the Founder Control Center: fixed-pool emission vs plan, holding bands (merged to five or more holders each), concentration, faucets, sinks and self-funding. Never a per-player row, never a write.';
