\set ON_ERROR_STOP on

-- Game analytics views and the marketing sheet for the Founder Control Center
-- (docs/game/admin-game-analytics-proposal.md, rollout step 3).
--
-- Both read telemetry.game_events, the server-written event table the
-- settlement functions fill, and never a client value. Whole days that the
-- roll-up has already written come from telemetry.game_event_daily; anything
-- later comes from the raw rows, so the answer is the same whether or not the
-- roll-up has run. A family no collector writes yet is `not_connected`, never
-- zero, and the admin role gets no grant on the telemetry schema - only these
-- EXECUTE-only functions, which never return an account id.

CREATE OR REPLACE FUNCTION admin.game_analytics(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 90);
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_from date := v_today - (least(greatest(coalesce(p_days, 30), 1), 90) - 1);
  v_rolled date;
  v_families jsonb;
  v_events jsonb;
  v_currency jsonb;
  v_series jsonb;
BEGIN
  IF to_regclass('telemetry.game_events') IS NULL OR to_regclass('telemetry.game_event_daily') IS NULL THEN
    RETURN jsonb_build_object('version', 'game-analytics.v1', 'as_of', now(), 'days', v_days, 'state', 'not_connected');
  END IF;

  SELECT rolled_through INTO v_rolled FROM telemetry.game_event_rollup_state;

  -- One aggregate over the window: rolled days from the daily table, the rest
  -- from raw rows, never both for the same day.
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.game_analytics_window (
    day date, event text, kind text, rarity text, hero_class text, outcome text, events bigint, qty numeric
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.game_analytics_window;

  INSERT INTO pg_temp.game_analytics_window
  SELECT day, event, kind, rarity, hero_class, outcome, sum(events), sum(qty)
  FROM telemetry.game_event_daily
  WHERE day >= v_from AND day <= coalesce(v_rolled, v_from - 1)
  GROUP BY day, event, kind, rarity, hero_class, outcome;

  INSERT INTO pg_temp.game_analytics_window
  SELECT (occurred_at AT TIME ZONE 'UTC')::date, event, coalesce(kind, ''), coalesce(rarity, ''), coalesce(hero_class, ''),
         coalesce(outcome, ''), count(*), sum(qty)
  FROM telemetry.game_events
  WHERE occurred_at >= (greatest(v_from, coalesce(v_rolled + 1, v_from)))::timestamp AT TIME ZONE 'UTC'
  GROUP BY 1, 2, 3, 4, 5, 6;

  -- Which families have ever been written, and since when. A family that has
  -- never had an event is a collector that is not wired, not a quiet game.
  SELECT jsonb_agg(jsonb_build_object(
           'family', k.family,
           'state', CASE WHEN f.first_day IS NULL THEN 'not_connected' ELSE 'connected' END,
           'collected_since', f.first_day
         ) ORDER BY k.family)
    INTO v_families
  FROM (SELECT DISTINCT family FROM telemetry.game_event_kinds) k
  LEFT JOIN (
    SELECT kinds.family, min(first_day) AS first_day FROM (
      SELECT event, min(day) AS first_day FROM telemetry.game_event_daily GROUP BY event
      UNION ALL
      SELECT event, (min(occurred_at) AT TIME ZONE 'UTC')::date FROM telemetry.game_events GROUP BY event
    ) seen JOIN telemetry.game_event_kinds kinds ON kinds.event = seen.event
    GROUP BY kinds.family
  ) f ON f.family = k.family;

  -- Per event in the window: totals and the breakdown by each dimension it
  -- carries. The dimensions are server vocabulary (kind, rarity, class,
  -- outcome), never a player or a free-text value.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'event', e.event, 'family', kinds.family, 'events', e.events, 'qty', e.qty,
           'by_kind', (SELECT jsonb_agg(jsonb_build_object('value', kind, 'events', events, 'qty', qty) ORDER BY qty DESC, kind)
                       FROM (SELECT kind, sum(events) AS events, sum(qty) AS qty FROM pg_temp.game_analytics_window w
                             WHERE w.event = e.event AND kind <> '' GROUP BY kind) x),
           'by_rarity', (SELECT jsonb_agg(jsonb_build_object('value', rarity, 'events', events, 'qty', qty) ORDER BY qty DESC, rarity)
                         FROM (SELECT rarity, sum(events) AS events, sum(qty) AS qty FROM pg_temp.game_analytics_window w
                               WHERE w.event = e.event AND rarity <> '' GROUP BY rarity) x),
           'by_class', (SELECT jsonb_agg(jsonb_build_object('value', hero_class, 'events', events, 'qty', qty) ORDER BY qty DESC, hero_class)
                        FROM (SELECT hero_class, sum(events) AS events, sum(qty) AS qty FROM pg_temp.game_analytics_window w
                              WHERE w.event = e.event AND hero_class <> '' GROUP BY hero_class) x),
           'by_outcome', (SELECT jsonb_agg(jsonb_build_object('value', outcome, 'events', events, 'qty', qty) ORDER BY qty DESC, outcome)
                          FROM (SELECT outcome, sum(events) AS events, sum(qty) AS qty FROM pg_temp.game_analytics_window w
                                WHERE w.event = e.event AND outcome <> '' GROUP BY outcome) x)
         ) ORDER BY kinds.family, e.event), '[]'::jsonb)
    INTO v_events
  FROM (SELECT event, sum(events) AS events, sum(qty) AS qty FROM pg_temp.game_analytics_window GROUP BY event) e
  JOIN telemetry.game_event_kinds kinds ON kinds.event = e.event;

  -- $HERO and Gold: earned and spent per registry kind, and the net.
  SELECT jsonb_build_object(
    'token', jsonb_build_object(
      'issued', coalesce(sum(qty) FILTER (WHERE event = 'token_issued'), 0),
      'spent', coalesce(sum(qty) FILTER (WHERE event = 'token_spent'), 0),
      'net', coalesce(sum(qty) FILTER (WHERE event = 'token_issued'), 0) - coalesce(sum(qty) FILTER (WHERE event = 'token_spent'), 0)
    ),
    'gold', jsonb_build_object(
      'earned', coalesce(sum(qty) FILTER (WHERE event = 'gold_earned'), 0),
      'spent', coalesce(sum(qty) FILTER (WHERE event = 'gold_spent'), 0),
      'net', coalesce(sum(qty) FILTER (WHERE event = 'gold_earned'), 0) - coalesce(sum(qty) FILTER (WHERE event = 'gold_spent'), 0)
    )
  ) INTO v_currency
  FROM pg_temp.game_analytics_window;

  -- Zero-filled daily series, so a quiet day is a zero on the line.
  SELECT jsonb_build_object(
    'days', jsonb_agg(to_char(d.day, 'YYYY-MM-DD') ORDER BY d.day),
    'token_issued', jsonb_agg(coalesce(s.token_issued, 0) ORDER BY d.day),
    'token_spent', jsonb_agg(coalesce(s.token_spent, 0) ORDER BY d.day),
    'gold_earned', jsonb_agg(coalesce(s.gold_earned, 0) ORDER BY d.day),
    'gold_spent', jsonb_agg(coalesce(s.gold_spent, 0) ORDER BY d.day)
  ) INTO v_series
  FROM generate_series(v_from, v_today, interval '1 day') AS d(day)
  LEFT JOIN (
    SELECT day,
      sum(qty) FILTER (WHERE event = 'token_issued') AS token_issued,
      sum(qty) FILTER (WHERE event = 'token_spent') AS token_spent,
      sum(qty) FILTER (WHERE event = 'gold_earned') AS gold_earned,
      sum(qty) FILTER (WHERE event = 'gold_spent') AS gold_spent
    FROM pg_temp.game_analytics_window GROUP BY day
  ) s ON s.day = d.day::date;

  RETURN jsonb_build_object(
    'version', 'game-analytics.v1',
    'as_of', now(),
    'days', v_days,
    'from', v_from,
    'state', 'connected',
    'rolled_through', v_rolled,
    'families', coalesce(v_families, '[]'::jsonb),
    'currency', v_currency,
    'events', v_events,
    'series', v_series
  );
END
$function$;

-- The marketing sheet: a fixed allowlist of public-safe totals, each with the
-- window it covers, where it comes from and since when that source has been
-- collected, so a published claim can be traced. Nothing per player. It only
-- prepares numbers: publishing any of them is external communication and needs
-- the Founder's approval.
CREATE OR REPLACE FUNCTION admin.game_analytics_marketing()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_have_events boolean := to_regclass('telemetry.game_events') IS NOT NULL AND to_regclass('telemetry.game_event_daily') IS NOT NULL;
  v_rolled date;
  v_figures jsonb := '[]'::jsonb;
  v_spec record;
  v_since date;
  v_all numeric;
  v_30 numeric;
  v_7 numeric;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Sign-ups (the same auth.users count Overview shows) and $HERO come from
  -- their own authoritative tables and cover the whole history; the rest come from game events and cover only the time the
  -- collector has been on.
  v_figures := v_figures || jsonb_build_array(jsonb_build_object(
    'key', 'players_registered', 'source', 'auth_users', 'state', 'connected', 'collected_since', NULL,
    'all_time', (SELECT count(*) FROM auth.users),
    'last_30_days', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '30 days'),
    'last_7_days', (SELECT count(*) FROM auth.users WHERE created_at >= now() - interval '7 days')
  ));

  IF to_regclass('public.hero_economy_ledger') IS NOT NULL THEN
    v_figures := v_figures || jsonb_build_array(jsonb_build_object(
      'key', 'hero_distributed', 'source', 'hero_economy_ledger', 'state', 'connected', 'collected_since', NULL,
      'all_time', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance'),
      'last_30_days', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance' AND occurred_at >= now() - interval '30 days'),
      'last_7_days', (SELECT coalesce(sum(amount), 0) FROM public.hero_economy_ledger WHERE flow = 'player_issuance' AND occurred_at >= now() - interval '7 days')
    ));
  ELSE
    v_figures := v_figures || jsonb_build_array(jsonb_build_object('key', 'hero_distributed', 'source', 'hero_economy_ledger', 'state', 'not_connected'));
  END IF;

  IF v_have_events THEN
    SELECT rolled_through INTO v_rolled FROM telemetry.game_event_rollup_state;
  END IF;

  -- key, event, measure: `events` counts rows, `qty` sums quantities (a
  -- monster_killed row carries how many died in one settlement).
  FOR v_spec IN SELECT * FROM (VALUES
    ('chests_opened', 'chest_opened', 'events'),
    ('heroes_summoned', 'hero_summoned', 'events'),
    ('monsters_defeated', 'monster_killed', 'qty'),
    ('bosses_defeated', 'boss_killed', 'events'),
    ('dungeons_cleared', 'dungeon_cleared', 'events'),
    ('items_enchanted', 'item_enchanted', 'events')
  ) AS spec(key, event, measure) LOOP
    IF NOT v_have_events THEN
      v_figures := v_figures || jsonb_build_array(jsonb_build_object('key', v_spec.key, 'source', 'game_events', 'event', v_spec.event, 'state', 'not_connected'));
      CONTINUE;
    END IF;
    SELECT least(
             (SELECT min(day) FROM telemetry.game_event_daily WHERE event = v_spec.event),
             (SELECT (min(occurred_at) AT TIME ZONE 'UTC')::date FROM telemetry.game_events WHERE event = v_spec.event))
      INTO v_since;
    IF v_since IS NULL THEN
      v_figures := v_figures || jsonb_build_array(jsonb_build_object('key', v_spec.key, 'source', 'game_events', 'event', v_spec.event, 'state', 'not_connected'));
      CONTINUE;
    END IF;
    WITH combined AS (
      SELECT day, CASE WHEN v_spec.measure = 'qty' THEN qty ELSE events END AS amount
      FROM telemetry.game_event_daily WHERE event = v_spec.event AND day <= coalesce(v_rolled, '-infinity'::date)
      UNION ALL
      SELECT (occurred_at AT TIME ZONE 'UTC')::date, CASE WHEN v_spec.measure = 'qty' THEN qty ELSE 1 END
      FROM telemetry.game_events
      WHERE event = v_spec.event AND occurred_at >= (coalesce(v_rolled + 1, '-infinity'::date))::timestamp AT TIME ZONE 'UTC'
    )
    SELECT coalesce(sum(amount), 0),
           coalesce(sum(amount) FILTER (WHERE day > v_today - 30), 0),
           coalesce(sum(amount) FILTER (WHERE day > v_today - 7), 0)
      INTO v_all, v_30, v_7
    FROM combined;
    v_figures := v_figures || jsonb_build_array(jsonb_build_object(
      'key', v_spec.key, 'source', 'game_events', 'event', v_spec.event, 'state', 'connected',
      'collected_since', v_since, 'all_time', v_all, 'last_30_days', v_30, 'last_7_days', v_7
    ));
  END LOOP;

  RETURN jsonb_build_object('version', 'marketing-sheet.v1', 'generated_at', now(), 'figures', v_figures);
END
$function$;

REVOKE ALL ON FUNCTION admin.game_analytics(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.game_analytics_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.game_analytics(integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.game_analytics_marketing() TO heroloop_admin;

COMMENT ON FUNCTION admin.game_analytics(integer) IS
  'Game event analytics over a clamped 1-90 day window: families connected or not, per-event totals by server dimensions, $HERO and Gold earned/spent and zero-filled daily series; never an account id.';
COMMENT ON FUNCTION admin.game_analytics_marketing() IS
  'Marketing sheet: fixed allowlist of public-safe totals (all time, 30 and 7 days) with source and collection start; preparing only, publishing needs Founder approval.';
