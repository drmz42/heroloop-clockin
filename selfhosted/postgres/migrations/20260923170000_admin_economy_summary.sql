\set ON_ERROR_STOP on

-- Economy read model for the Founder Control Center
-- (config/admin-economy-operations.v1.json, admin-analytics.v1.json).
--
-- Aggregates only: this function returns totals and per-source sums, never a
-- per-player row, so the Economy screen can never become a way to read one
-- player's wallet. heroloop_admin_runtime keeps no grant on any public.* table
-- and gains EXECUTE on this one function.
--
-- Nothing here writes. The only economy mutation the contract allows is a
-- registered compensating correction, which is financially material and stays
-- behind its own approval; the panel has no path to it.

CREATE OR REPLACE FUNCTION admin.economy_summary(p_window_hours integer DEFAULT 24)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  -- A caller-supplied window is clamped rather than trusted: an unbounded
  -- range would turn a dashboard refresh into a full-table scan.
  v_hours integer := least(greatest(coalesce(p_window_hours, 24), 1), 720);
  v_since timestamptz := now() - make_interval(hours => v_hours);
  v_supply jsonb;
  v_gold numeric;
  v_risk jsonb;
  v_ledger jsonb;
  v_window_flows jsonb;
  v_window_sources jsonb;
BEGIN
  SELECT jsonb_build_object(
    'players_total', count(*),
    'token_balance_total', round(coalesce(sum(token_balance), 0), 2),
    'pending_tokens_total', round(coalesce(sum(pending_tokens), 0), 2),
    'total_claimed_total', round(coalesce(sum(total_claimed), 0), 2),
    'token_eligible_players', count(*) FILTER (WHERE token_eligible),
    'online_players', count(*) FILTER (WHERE online)
  ) INTO v_supply FROM public.players;

  -- Gold lives inside the save document, so it is summed from there rather
  -- than from a column that does not exist.
  SELECT round(coalesce(sum((state->>'gold')::numeric), 0), 2) INTO v_gold
  FROM public.player_saves WHERE state ? 'gold';

  SELECT coalesce(jsonb_object_agg(level, accounts), '{}'::jsonb) INTO v_risk
  FROM (SELECT level, count(*) AS accounts FROM public.account_risk_levels GROUP BY level) risk;

  SELECT jsonb_build_object(
    'rows_total', count(*),
    'first_at', min(occurred_at),
    'last_at', max(occurred_at),
    'by_flow', coalesce((
      SELECT jsonb_object_agg(flow, jsonb_build_object('entries', entries, 'amount', amount))
      FROM (SELECT flow, count(*) AS entries, round(sum(amount), 2) AS amount FROM public.hero_economy_ledger GROUP BY flow) totals
    ), '{}'::jsonb)
  ) INTO v_ledger FROM public.hero_economy_ledger;

  SELECT coalesce(jsonb_object_agg(flow, jsonb_build_object('entries', entries, 'amount', amount)), '{}'::jsonb)
  INTO v_window_flows
  FROM (
    SELECT flow, count(*) AS entries, round(sum(amount), 2) AS amount
    FROM public.hero_economy_ledger WHERE occurred_at >= v_since GROUP BY flow
  ) windowed;

  SELECT coalesce(jsonb_agg(jsonb_build_object('source_kind', source_kind, 'entries', entries, 'amount', amount)
    ORDER BY amount DESC), '[]'::jsonb)
  INTO v_window_sources
  FROM (
    SELECT source_kind, count(*) AS entries, round(sum(amount), 2) AS amount
    FROM public.hero_economy_ledger WHERE occurred_at >= v_since
    GROUP BY source_kind ORDER BY sum(amount) DESC LIMIT 10
  ) sources;

  RETURN jsonb_build_object(
    'as_of', now(),
    'window_hours', v_hours,
    'gold_total', v_gold,
    'supply', v_supply,
    'risk_accounts', v_risk,
    'ledger', v_ledger,
    'window_flows', v_window_flows,
    'window_sources', v_window_sources
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.economy_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.economy_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.economy_summary(integer) IS
  'Aggregate-only economy read for the Founder Control Center: totals and per-source sums, never a per-player row, never a write.';
