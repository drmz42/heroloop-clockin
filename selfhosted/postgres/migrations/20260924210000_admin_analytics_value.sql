\set ON_ERROR_STOP on

-- Analytics v2: player value in a game that sells nothing for money
-- (docs/game/admin-analytics-proposal.md, docs/game/founder-control-center-v2-tz.md).
--
-- Replaces admin.analytics_summary from 20260924120000. Funnel, cohorts,
-- retention and segments are unchanged; what is new is the answer to the
-- question LTV/ARPU was standing in for.
--
-- HeroLoop takes no money from players, so LTV and ARPU in currency have no
-- source and will not get one while that stays true. They are reported as
-- 'not_applicable' with the reason rather than 'not_connected', because the
-- second promises a source that is merely missing, and never as zero.
--
-- The same two questions do have an answer in the game's own economy, and it is
-- computed here: how much $HERO reached players per active account inside the
-- window (the ARPU-shaped question) and how much value an account is holding
-- across its life, overall and per weekly sign-up cohort (the LTV-shaped one).
-- Every figure is an average over at least p_min_cohort accounts; below the
-- threshold it is withheld exactly like every count on this screen. The ledger
-- is probed with to_regclass, so a database without it reports the issuance
-- half as not connected instead of as a zero nobody earned.

CREATE OR REPLACE FUNCTION admin.analytics_summary(p_min_cohort integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_min integer := least(greatest(coalesce(p_min_cohort, 5), 5), 1000);
  v_now timestamptz := now();
  v_window_days integer := 30;
  v_funnel jsonb;
  v_cohorts jsonb;
  v_segments jsonb;
  v_value jsonb;
  v_accounts bigint;
  v_players bigint;
  v_active bigint;
  v_ledger boolean := to_regclass('public.hero_economy_ledger') IS NOT NULL;
  v_issued numeric;
  v_spent numeric;
  v_lifetime numeric;
  v_gold numeric;
BEGIN
  SELECT count(*) INTO v_accounts FROM auth.users;
  SELECT count(*) INTO v_players FROM public.players;

  -- Ordered, cumulative steps. Tutorial has no server column, so it is named as
  -- untracked instead of being inferred from a neighbouring step.
  SELECT jsonb_build_array(
    jsonb_build_object('key', 'registered', 'count', CASE WHEN v_accounts >= v_min THEN v_accounts END, 'suppressed', v_accounts < v_min),
    jsonb_build_object('key', 'tutorial', 'count', NULL, 'suppressed', false, 'state', 'not_tracked'),
    jsonb_build_object('key', 'first_battle', 'count', CASE WHEN c.b >= v_min THEN c.b END, 'suppressed', c.b < v_min),
    jsonb_build_object('key', 'first_chest', 'count', CASE WHEN c.c >= v_min THEN c.c END, 'suppressed', c.c < v_min),
    jsonb_build_object('key', 'first_summon', 'count', CASE WHEN c.s >= v_min THEN c.s END, 'suppressed', c.s < v_min)
  ) INTO v_funnel
  FROM (
    SELECT count(*) FILTER (WHERE total_kills > 0) AS b,
           count(*) FILTER (WHERE chests_opened > 0) AS c,
           count(*) FILTER (WHERE summons > 0) AS s
    FROM public.players
  ) c;

  -- Last eight whole UTC weeks plus the current one: well inside the 180-day
  -- lookback cap. Day-N counts need the whole cohort to have reached day N.
  -- value_avg is the cohort's held value per account that actually played, so a
  -- cohort of sign-ups who never opened the game does not divide it away.
  WITH weeks AS (
    SELECT generate_series(
      date_trunc('week', (v_now AT TIME ZONE 'UTC')) - interval '8 weeks',
      date_trunc('week', (v_now AT TIME ZONE 'UTC')),
      interval '1 week'
    ) AS week_start
  ), cohort AS (
    SELECT w.week_start,
           count(u.id) AS size,
           count(p.player_id) AS played,
           count(*) FILTER (WHERE p.last_heartbeat >= u.created_at + interval '1 day') AS d1,
           count(*) FILTER (WHERE p.last_heartbeat >= u.created_at + interval '7 days') AS d7,
           count(*) FILTER (WHERE p.last_heartbeat >= u.created_at + interval '30 days') AS d30,
           round(avg(coalesce(p.total_claimed, 0) + coalesce(p.token_balance, 0) + coalesce(p.pending_tokens, 0))
                 FILTER (WHERE p.player_id IS NOT NULL), 2) AS value_avg
    FROM weeks w
    LEFT JOIN auth.users u
      ON (u.created_at AT TIME ZONE 'UTC') >= w.week_start
     AND (u.created_at AT TIME ZONE 'UTC') < w.week_start + interval '1 week'
    LEFT JOIN public.players p ON p.player_id = u.id
    GROUP BY w.week_start
  )
  SELECT coalesce(jsonb_agg(
    CASE WHEN c.size < v_min THEN
      jsonb_build_object('week_start', to_char(c.week_start, 'YYYY-MM-DD'), 'suppressed', true,
                         'size', NULL, 'played', NULL, 'd1', NULL, 'd7', NULL, 'd30', NULL, 'value_avg', NULL)
    ELSE
      jsonb_build_object(
        'week_start', to_char(c.week_start, 'YYYY-MM-DD'), 'suppressed', false,
        'size', c.size,
        'played', CASE WHEN c.played >= v_min THEN c.played END,
        'd1', CASE WHEN c.week_start + interval '1 week' + interval '1 day' <= (v_now AT TIME ZONE 'UTC') AND c.d1 >= v_min THEN c.d1 END,
        'd7', CASE WHEN c.week_start + interval '1 week' + interval '7 days' <= (v_now AT TIME ZONE 'UTC') AND c.d7 >= v_min THEN c.d7 END,
        'd30', CASE WHEN c.week_start + interval '1 week' + interval '30 days' <= (v_now AT TIME ZONE 'UTC') AND c.d30 >= v_min THEN c.d30 END,
        'mature_d1', c.week_start + interval '1 week' + interval '1 day' <= (v_now AT TIME ZONE 'UTC'),
        'mature_d7', c.week_start + interval '1 week' + interval '7 days' <= (v_now AT TIME ZONE 'UTC'),
        'mature_d30', c.week_start + interval '1 week' + interval '30 days' <= (v_now AT TIME ZONE 'UTC'),
        'value_avg', CASE WHEN c.played >= v_min THEN c.value_avg END
      )
    END
    ORDER BY c.week_start DESC), '[]'::jsonb)
  INTO v_cohorts FROM cohort c;

  -- Segments by account level band, players only.
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'band', s.band,
      'players', CASE WHEN s.n >= v_min THEN s.n END,
      'active_7d', CASE WHEN s.n >= v_min AND s.a >= v_min THEN s.a END,
      'suppressed', s.n < v_min
    ) ORDER BY s.ord), '[]'::jsonb)
  INTO v_segments
  FROM (
    SELECT b.ord, b.band, count(p.player_id) AS n,
           count(*) FILTER (WHERE p.last_heartbeat >= v_now - interval '7 days') AS a
    FROM (VALUES (1, '1-9', 1, 9), (2, '10-24', 10, 24), (3, '25-49', 25, 49), (4, '50+', 50, 2147483647)) AS b(ord, band, lo, hi)
    LEFT JOIN public.players p ON p.account_level BETWEEN b.lo AND b.hi
    GROUP BY b.ord, b.band
  ) s;

  -- Player value, the money-free replacement for LTV/ARPU.
  SELECT count(*) INTO v_active
  FROM public.players WHERE last_heartbeat >= v_now - make_interval(days => v_window_days);

  SELECT round(avg(token_balance + pending_tokens + total_claimed), 2) INTO v_lifetime FROM public.players;

  -- Gold lives inside the save document, so a value that is not a plain number
  -- is skipped rather than cast into an error.
  SELECT round(avg((state->>'gold')::numeric), 2) INTO v_gold
  FROM public.player_saves
  WHERE state ? 'gold' AND (state->>'gold') ~ '^[0-9]+([.][0-9]+)?$';

  IF v_ledger THEN
    SELECT round(coalesce(sum(amount) FILTER (WHERE flow = 'player_issuance'), 0), 2),
           round(coalesce(sum(amount) FILTER (WHERE flow = 'treasury_inflow'), 0), 2)
      INTO v_issued, v_spent
    FROM public.hero_economy_ledger
    WHERE occurred_at >= v_now - make_interval(days => v_window_days);
  END IF;

  v_value := jsonb_build_object(
    'state', CASE WHEN v_ledger THEN 'connected' ELSE 'partial' END,
    'currency', 'HERO',
    'window_days', v_window_days,
    'accounts_active', CASE WHEN v_active >= v_min THEN v_active END,
    'issued_window', CASE WHEN v_ledger THEN v_issued END,
    'spent_window', CASE WHEN v_ledger THEN v_spent END,
    'issued_per_active', CASE WHEN v_ledger AND v_active >= v_min THEN round(v_issued / v_active, 2) END,
    'spent_per_active', CASE WHEN v_ledger AND v_active >= v_min THEN round(v_spent / v_active, 2) END,
    'lifetime_per_account', CASE WHEN v_players >= v_min THEN v_lifetime END,
    'gold_per_account', CASE WHEN v_players >= v_min THEN v_gold END,
    'suppressed', v_players < v_min OR v_active < v_min,
    'note', 'in-game currency only; no money passes through the game'
  );

  RETURN jsonb_build_object(
    'version', 'analytics.v2',
    'as_of', v_now,
    'timezone', 'UTC',
    'min_cohort', v_min,
    'coverage', jsonb_build_object(
      'accounts', v_accounts,
      'players', v_players,
      'lookback_days', 63,
      'source', 'auth sign-up time, the server-written players row and the $HERO ledger',
      'retention_measure', 'last_seen_on_or_after_day_n',
      'value_measure', 'in_game_currency_only'
    ),
    'funnel', v_funnel,
    'cohorts', v_cohorts,
    'segments', v_segments,
    'player_value', v_value,
    'ltv_arpu', 'not_applicable',
    'ltv_arpu_reason', 'no_money_payments',
    'ab_results', 'not_connected'
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.analytics_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.analytics_summary(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.analytics_summary(integer) IS
  'Versioned aggregate-only Analytics read for the Founder Control Center: funnel, weekly cohorts, last-seen retention, level segments and in-game player value with small-cohort suppression; money LTV/ARPU is not applicable because the game takes no payments. Never a per-player row, never a write.';
