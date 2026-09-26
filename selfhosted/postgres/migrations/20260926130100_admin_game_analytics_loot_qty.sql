\set ON_ERROR_STOP on

-- The chest and summon collectors (20260926130000_game_events_loot_collectors)
-- write one row per settlement group with the count in qty, so the marketing
-- sheet sums qty for chests opened and heroes summoned instead of counting
-- rows. Everything else is unchanged from 20260926030000_admin_game_analytics.

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
    ('chests_opened', 'chest_opened', 'qty'),
    ('heroes_summoned', 'hero_summoned', 'qty'),
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

REVOKE ALL ON FUNCTION admin.game_analytics_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.game_analytics_marketing() TO heroloop_admin;
