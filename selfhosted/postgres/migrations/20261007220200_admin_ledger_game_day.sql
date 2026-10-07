-- Founder 2026-10-07: the daily $HERO ledger groups by the UTC game day.
BEGIN;
CREATE OR REPLACE FUNCTION admin.hero_ledger_daily(p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
    'timezone', 'UTC',
    'days', least(greatest(coalesce(p_days, 30), 1), 366),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'game_day', day, 'balance_version', balance_version, 'flow', flow, 'source_kind', source_kind,
      'event_count', n, 'amount', amount
    ) ORDER BY day DESC, flow, source_kind, balance_version), '[]'::jsonb)
  )
  FROM (
    SELECT public.heroloop_game_date(occurred_at) AS day,
           coalesce(economy_balance_version, 'unversioned') AS balance_version,
           flow, source_kind, count(*) AS n, sum(amount) AS amount
    FROM public.hero_economy_ledger
    WHERE occurred_at >= public.heroloop_game_day_start(public.heroloop_game_date(now()) - least(greatest(coalesce(p_days, 30), 1), 366) + 1)
    GROUP BY 1, 2, 3, 4
  ) d
$function$;

COMMIT;
