\set ON_ERROR_STOP on

-- Saved views and automatic reports for the Control Center
-- (docs/game/founder-control-center-v2-tz.md, Platform and Governance:
-- "Saved filters and automatic reports (for example a weekly Founder report).
--  Aggregates only; the report is sent through Founder notifications").
--
-- Two things live here and they are deliberately separate.
--
-- A saved view is one person's filter remembered by name. It holds no result,
-- no number and no player: only the controls a screen already exposes, as a
-- flat object of short scalars, so restoring a view can never show more than
-- opening that screen and setting the same filters by hand would. The player
-- support screen is refused outright, because its filter *is* one player's key.
--
-- The weekly report is the aggregate answer to "what happened last week",
-- computed over an explicit UTC week rather than a rolling window: a report
-- about the week that ended must not drift every time it is opened. It is
-- composed here rather than assembled from the other read models because those
-- answer "as of now", and "new in the last seven days" is not the same question
-- as "new in week 39". The same suppression rule applies: a share over a cohort
-- below the threshold is withheld, and a source whose table is absent reports
-- not connected rather than zero.
--
-- Nothing here sends anything. Delivery is the notification queue's job: the
-- dispatcher timer asks for the finished week once, hands it to
-- admin.notification_record and the existing delivery pass carries it.

-- ---------------------------------------------------------------------------
-- Saved views
-- ---------------------------------------------------------------------------

-- A CHECK constraint cannot contain a subquery, and what makes a filter safe is
-- a statement about every one of its entries. So the rule lives in one immutable
-- function and the table enforces it: a flat object of at most a dozen named
-- scalars, each key a plain identifier and each string short. Not an object, not
-- an array, not a document - so this table cannot quietly become a second place
-- where panel state, results or player data accumulate outside the read models.
CREATE OR REPLACE FUNCTION admin.saved_view_filters_are_flat(p_filters jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_typeof(p_filters) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(p_filters)) <= 12
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p_filters) AS entry(key, value)
       WHERE jsonb_typeof(entry.value) NOT IN ('string', 'number', 'boolean')
          OR entry.key !~ '^[a-z][a-z0-9_]{0,31}$'
          OR (jsonb_typeof(entry.value) = 'string' AND char_length(entry.value #>> '{}') > 80)
     );
$function$;

REVOKE ALL ON FUNCTION admin.saved_view_filters_are_flat(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION admin.saved_view_filters_are_flat(jsonb) IS
  'The shape rule behind the saved_views CHECK constraint: a flat object of at most twelve named scalars with short strings.';

CREATE TABLE IF NOT EXISTS admin.saved_views (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- A view belongs to the person who saved it. Nobody reads anybody else's, and
  -- removing an identity removes their views with it.
  owner_identity_id uuid NOT NULL REFERENCES admin.identities(id) ON DELETE CASCADE,
  screen text NOT NULL CHECK (screen ~ '^[a-z][a-z0-9-]{2,31}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_identity_id, screen, name),
  -- The screen whose filter is a single player's key cannot be saved at all.
  -- A remembered search is a stored identifier, whatever it is called.
  CONSTRAINT saved_views_screen_is_aggregate CHECK (screen NOT IN ('players', 'player-support')),
  -- A filter is what a control on the screen can hold: a handful of named
  -- scalars, and nothing else.
  CONSTRAINT saved_views_filters_are_flat CHECK (admin.saved_view_filters_are_flat(filters)),
  -- Same shapes the notification text refuses, for the same reason: an address
  -- or a 26-character run of letters and digits is an identifier, and an
  -- identifier has no business being remembered as a filter.
  CONSTRAINT saved_views_carry_no_contact CHECK (position('@' IN filters::text) = 0),
  CONSTRAINT saved_views_carry_no_identifier CHECK (filters::text !~ '[A-Za-z0-9]{26}'),
  -- A player id is a UUID: its dashes break the run above into twelves, so the
  -- shape this panel handles most is named on its own.
  CONSTRAINT saved_views_carry_no_player_id CHECK (
    filters::text !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  )
);

CREATE INDEX IF NOT EXISTS saved_views_owner_idx ON admin.saved_views(owner_identity_id, screen, name);

COMMENT ON TABLE admin.saved_views IS
  'One person''s named filters per screen: flat scalars only, never a result, never a player key, and never readable by another identity.';

CREATE OR REPLACE FUNCTION admin.saved_view_list(p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_views jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(row ORDER BY row->>'screen', row->>'name'), '[]'::jsonb)
  INTO v_views
  FROM (
    SELECT jsonb_build_object(
      'id', id,
      'screen', screen,
      'name', name,
      'filters', filters,
      'created_at', created_at,
      'updated_at', updated_at
    ) AS row
    FROM admin.saved_views
    WHERE owner_identity_id = p_owner
  ) rows;

  RETURN jsonb_build_object('as_of', now(), 'views', v_views);
END
$function$;

REVOKE ALL ON FUNCTION admin.saved_view_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.saved_view_list(uuid) TO heroloop_admin;

COMMENT ON FUNCTION admin.saved_view_list(uuid) IS
  'The saved views of one identity. Scoped by the owner argument, so no caller can read another person''s views.';

-- Saving the same name twice replaces the filters rather than growing a second
-- row: a view is a name the person reuses, not an append-only log.
CREATE OR REPLACE FUNCTION admin.saved_view_save(
  p_owner uuid,
  p_screen text,
  p_name text,
  p_filters jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  -- A cap per person, so a scripted caller cannot turn this into storage.
  v_limit constant integer := 40;
  v_count integer;
  v_id bigint;
  v_created boolean := false;
BEGIN
  SELECT count(*) INTO v_count FROM admin.saved_views WHERE owner_identity_id = p_owner;

  SELECT id INTO v_id FROM admin.saved_views
  WHERE owner_identity_id = p_owner AND screen = p_screen AND name = p_name;

  IF v_id IS NULL AND v_count >= v_limit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'saved_view_limit', 'limit', v_limit);
  END IF;

  INSERT INTO admin.saved_views(owner_identity_id, screen, name, filters)
  VALUES (p_owner, p_screen, p_name, coalesce(p_filters, '{}'::jsonb))
  ON CONFLICT (owner_identity_id, screen, name)
  DO UPDATE SET filters = excluded.filters, updated_at = now()
  RETURNING id, (xmax = 0) INTO v_id, v_created;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'created', v_created);
END
$function$;

REVOKE ALL ON FUNCTION admin.saved_view_save(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.saved_view_save(uuid, text, text, jsonb) TO heroloop_admin;

COMMENT ON FUNCTION admin.saved_view_save(uuid, text, text, jsonb) IS
  'Writes one named filter for one identity, replacing that name''s filters if it exists. The table constraints, not this function, decide what a filter may contain.';

CREATE OR REPLACE FUNCTION admin.saved_view_delete(p_owner uuid, p_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  -- Owner-scoped, so an id guessed from somebody else's session deletes nothing.
  DELETE FROM admin.saved_views WHERE id = p_id AND owner_identity_id = p_owner;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', v_deleted > 0, 'deleted', v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION admin.saved_view_delete(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.saved_view_delete(uuid, bigint) TO heroloop_admin;

COMMENT ON FUNCTION admin.saved_view_delete(uuid, bigint) IS
  'Removes one of the caller''s own saved views. Scoped by owner, so another identity''s view id deletes nothing.';

-- ---------------------------------------------------------------------------
-- The weekly report
-- ---------------------------------------------------------------------------

-- What was already sent, so a dispatcher that runs every few minutes reports a
-- finished week exactly once. Append-only: a report is a statement about a week
-- that has ended and is never edited afterwards.
CREATE TABLE IF NOT EXISTS admin.report_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('weekly')),
  -- The Monday 00:00 UTC the reported week starts at; one row per week per kind.
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL,
  notification_id bigint REFERENCES admin.notifications(id),
  UNIQUE (kind, period_start)
);

CREATE INDEX IF NOT EXISTS report_runs_period_idx ON admin.report_runs(kind, period_start DESC);

COMMENT ON TABLE admin.report_runs IS
  'One row per reported period: what the weekly aggregate said and which notification carried it. Append-only, so a week is reported once.';

-- The report itself. p_weeks_back = 0 is the week in progress, 1 the week that
-- has just ended - which is the one the dispatcher sends.
CREATE OR REPLACE FUNCTION admin.report_weekly(p_weeks_back integer DEFAULT 1, p_min_cohort integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_back integer := least(greatest(coalesce(p_weeks_back, 1), 0), 52);
  v_min_cohort integer := least(greatest(coalesce(p_min_cohort, 5), 1), 1000);
  -- ISO weeks, Monday to Monday, in UTC. date_trunc on a timestamptz answers in
  -- the session time zone, so the week boundary is computed in UTC explicitly
  -- and turned back into an instant; otherwise the same report would cover a
  -- different week depending on who connected.
  v_start timestamptz := (date_trunc('week', (now() AT TIME ZONE 'UTC')) - make_interval(weeks => v_back)) AT TIME ZONE 'UTC';
  v_end timestamptz := v_start + interval '7 days';
  v_complete boolean := v_end <= now();
  v_accounts jsonb;
  v_players jsonb;
  v_economy jsonb;
  v_support jsonb;
  v_alerts jsonb;
  v_new bigint;
  v_active bigint;
  v_cohort bigint;
  v_cohort_active bigint;
BEGIN
  -- Sign-ups inside the week, and how many accounts existed when it ended.
  SELECT count(*) FILTER (WHERE created_at >= v_start AND created_at < v_end),
         count(*) FILTER (WHERE created_at < v_end)
  INTO v_new, v_cohort
  FROM auth.users;

  v_accounts := jsonb_build_object('new', v_new, 'total_at_end', v_cohort);

  -- public.players carries one last-seen timestamp per player, not an event
  -- history, so "how many played during week 38" is a question this database
  -- cannot answer: a player who has played every day since only ever appears in
  -- the current week. What the column does answer exactly is how many players
  -- were last seen inside the week, so that is what is returned, under that
  -- name. The real activity measure is the sampler's, below.
  SELECT count(*) FILTER (WHERE last_heartbeat >= v_start AND last_heartbeat < v_end)
  INTO v_active
  FROM public.players;

  -- Did the people who signed up during the week come back after it? Only asked
  -- of a week that has ended, and only when the cohort is large enough for a
  -- share to describe a trend rather than a handful of people.
  SELECT count(*), count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM public.players p
      WHERE p.player_id = u.id AND p.last_heartbeat >= v_end
    )
  )
  INTO v_cohort, v_cohort_active
  FROM auth.users u
  WHERE u.created_at >= v_start AND u.created_at < v_end;

  v_players := jsonb_build_object(
    'last_seen_in_week', v_active,
    -- The sampler writes online and 24-hour-active counts while it is
    -- installed. A week it did not cover reports that, rather than a peak of
    -- zero, which would read as "nobody played".
    'sampled', CASE
      WHEN to_regclass('admin.activity_samples') IS NULL THEN jsonb_build_object('state', 'not_connected')
      ELSE coalesce(
        (SELECT jsonb_build_object(
           'state', 'connected',
           'samples', count(*),
           'peak_online', max(online_now),
           'peak_active_24h', max(active_24h)
         )
         FROM admin.activity_samples
         WHERE sampled_at >= v_start AND sampled_at < v_end
         HAVING count(*) > 0),
        jsonb_build_object('state', 'not_sampled'))
    END,
    'returned', jsonb_build_object(
      'kind', 'signed_up_in_week_and_seen_after_it',
      'cohort', v_cohort,
      'returned', CASE WHEN v_complete THEN v_cohort_active ELSE NULL END,
      'share', CASE
        WHEN v_complete AND v_cohort >= v_min_cohort THEN round(v_cohort_active::numeric / v_cohort, 4)
        ELSE NULL
      END,
      'min_cohort', v_min_cohort
    )
  );

  -- The ledger, summed per flow over the week. Probed on its own, because a
  -- database without the ledger has no answer here, which is not the same as a
  -- week in which nothing moved.
  IF to_regclass('public.hero_economy_ledger') IS NULL THEN
    v_economy := jsonb_build_object('state', 'not_connected');
  ELSE
    SELECT jsonb_build_object(
      'state', 'connected',
      'entries', count(*),
      'by_flow', coalesce(
        (SELECT jsonb_object_agg(flow, jsonb_build_object('entries', entries, 'amount', amount))
           FROM (
             SELECT flow, count(*) AS entries, sum(amount) AS amount
             FROM public.hero_economy_ledger
             WHERE occurred_at >= v_start AND occurred_at < v_end
             GROUP BY flow
           ) flows),
        '{}'::jsonb),
      -- Per-source totals, never per player: the recipients are counted, not
      -- listed, and the count is withheld under the cohort threshold for the
      -- same reason a share is.
      'recipients', CASE
        WHEN count(DISTINCT player_id) >= v_min_cohort THEN count(DISTINCT player_id)
        ELSE NULL
      END
    )
    INTO v_economy
    FROM public.hero_economy_ledger
    WHERE occurred_at >= v_start AND occurred_at < v_end;
  END IF;

  -- What the panel itself did during the week: counts of operations, notes and
  -- deletions, never who they were about.
  v_support := jsonb_build_object(
    'risk_changes', (SELECT count(*) FROM admin.player_operations WHERE created_at >= v_start AND created_at < v_end),
    'notes', (SELECT count(*) FROM admin.support_notes WHERE created_at >= v_start AND created_at < v_end),
    'account_deletions', CASE
      WHEN to_regclass('admin.account_deletions') IS NULL THEN NULL
      ELSE (SELECT count(*) FROM admin.account_deletions WHERE created_at >= v_start AND created_at < v_end)
    END
  );

  -- And what it raised. Severity counts only; the alert text has its own screen.
  IF to_regclass('admin.notifications') IS NULL THEN
    v_alerts := jsonb_build_object('state', 'not_connected');
  ELSE
    SELECT jsonb_build_object(
      'state', 'connected',
      'total', count(*),
      'critical', count(*) FILTER (WHERE severity = 'critical'),
      'warning', count(*) FILTER (WHERE severity = 'warning'),
      'unacknowledged', count(*) FILTER (WHERE acknowledged_at IS NULL)
    )
    INTO v_alerts
    FROM admin.notifications
    WHERE created_at >= v_start AND created_at < v_end;
  END IF;

  RETURN jsonb_build_object(
    'version', 'weekly.v1',
    'as_of', now(),
    'period', jsonb_build_object(
      'kind', 'iso_week_utc',
      'start', v_start,
      'end', v_end,
      'iso_year', extract(isoyear FROM v_start)::integer,
      'iso_week', extract(week FROM v_start)::integer,
      -- An unfinished week is reported as such, so a number read mid-week is
      -- not mistaken for the week's result.
      'complete', v_complete
    ),
    'accounts', v_accounts,
    'players', v_players,
    'economy', v_economy,
    'support', v_support,
    'alerts', v_alerts
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.report_weekly(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.report_weekly(integer, integer) TO heroloop_admin;
GRANT SELECT ON admin.saved_views, admin.report_runs TO heroloop_admin;

COMMENT ON FUNCTION admin.report_weekly(integer, integer) IS
  'The aggregate weekly Founder report over one whole UTC week: sign-ups, activity, ledger flows, panel operations and alerts. Counts only, shares withheld below the cohort threshold, absent sources reported as not connected.';

-- Records the finished week once and hands it to the notification queue. This
-- is the only place the two meet: the panel can read a report but has no route
-- that reaches this function, exactly as it has none that can raise an alert.
CREATE OR REPLACE FUNCTION admin.report_weekly_enqueue()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_report jsonb := admin.report_weekly(1);
  v_start timestamptz := (v_report->'period'->>'start')::timestamptz;
  v_end timestamptz := (v_report->'period'->>'end')::timestamptz;
  v_week integer := (v_report->'period'->>'iso_week')::integer;
  v_existing bigint;
  v_recorded jsonb;
  v_id bigint;
BEGIN
  SELECT id INTO v_existing FROM admin.report_runs WHERE kind = 'weekly' AND period_start = v_start;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'already_reported', 'id', v_existing);
  END IF;

  -- Server-authored text over server-computed counts: there is no free-text
  -- input on this path at all, and the queue's own constraints still refuse an
  -- address or an identifier if a future edit ever introduced one.
  v_recorded := admin.notification_record(
    'weekly_report',
    'report',
    'report:weekly:' || to_char(v_start, 'IYYY"w"IW'),
    format('Weekly report: week %s', v_week),
    format(
      'Sign-ups: %s. Last sign-in this week: %s. Ledger entries: %s. Support operations: %s. Alerts: %s.',
      v_report->'accounts'->>'new',
      v_report->'players'->>'last_seen_in_week',
      coalesce(v_report->'economy'->>'entries', 'no data'),
      (coalesce((v_report->'support'->>'risk_changes')::bigint, 0) + coalesce((v_report->'support'->>'notes')::bigint, 0))::text,
      coalesce(v_report->'alerts'->>'total', 'no data')
    ),
    -- One report per week; the cooldown is the week itself.
    160
  );

  v_id := (v_recorded->>'id')::bigint;

  INSERT INTO admin.report_runs(kind, period_start, period_end, report, notification_id)
  VALUES ('weekly', v_start, v_end, v_report, v_id)
  ON CONFLICT (kind, period_start) DO NOTHING;

  RETURN jsonb_build_object('recorded', true, 'period_start', v_start, 'notification_id', v_id);
END
$function$;

REVOKE ALL ON FUNCTION admin.report_weekly_enqueue() FROM PUBLIC;

COMMENT ON FUNCTION admin.report_weekly_enqueue() IS
  'Records the week that has ended and enqueues one Founder notification carrying it. Called by the dispatcher timer only; the panel has no route that reaches it.';

-- The queue was built for conditions that go wrong. A report is neither a
-- warning nor an informational aside that stays in the panel: it is the one
-- thing that is meant to arrive on schedule. It gets its own source and its own
-- severity so it cannot be mistaken for an incident, and so the delivery rule -
-- everything but 'info' is sent - carries it without being loosened.
ALTER TABLE admin.notifications DROP CONSTRAINT IF EXISTS notifications_source_check;
ALTER TABLE admin.notifications ADD CONSTRAINT notifications_source_check
  CHECK (source IN ('alerts', 'approval_queue', 'backup_failure', 'economy_anomalies', 'weekly_report'));

ALTER TABLE admin.notifications DROP CONSTRAINT IF EXISTS notifications_severity_check;
ALTER TABLE admin.notifications ADD CONSTRAINT notifications_severity_check
  CHECK (severity IN ('critical', 'warning', 'info', 'report'));

-- The queue's own read has to know about the new source, or a report would be
-- delivered by a channel the panel reports as having four sources. Replaced
-- whole, as analytics.v2 replaced its predecessor: the shape gains one source
-- and one counter, and says so in its version.
CREATE OR REPLACE FUNCTION admin.notification_feed(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  -- A scan that has not run for half an hour is a source that stopped
  -- answering, not a source with nothing to say.
  v_stale interval := interval '30 minutes';
  v_host_run timestamptz;
  v_db_run timestamptz;
  v_counts jsonb;
  v_items jsonb;
  v_sources jsonb;
BEGIN
  SELECT max(ran_at) INTO v_host_run FROM admin.notification_runs WHERE kind = 'host';
  SELECT max(ran_at) INTO v_db_run FROM admin.notification_runs WHERE kind = 'database';

  SELECT jsonb_build_object(
    'total', count(*),
    'open', count(*) FILTER (WHERE acknowledged_at IS NULL),
    'open_critical', count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'critical'),
    'open_warning', count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'warning'),
    'open_info', count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'info'),
    'open_report', count(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'report'),
    'acknowledged_7d', count(*) FILTER (WHERE acknowledged_at >= now() - interval '7 days'),
    'delivery_pending', count(*) FILTER (WHERE delivery_state IN ('pending', 'sending')),
    'delivered_7d', count(*) FILTER (WHERE delivered_at >= now() - interval '7 days'),
    'delivery_failed', count(*) FILTER (WHERE delivery_state = 'failed'),
    'last_created_at', max(created_at),
    'last_delivered_at', max(delivered_at)
  ) INTO v_counts FROM admin.notifications;

  SELECT coalesce(jsonb_agg(row ORDER BY (row->>'created_at') DESC), '[]'::jsonb) INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'id', id,
      'source', source,
      'severity', severity,
      'dedupe_key', dedupe_key,
      'title', title,
      'body', body,
      'created_at', created_at,
      'last_seen_at', last_seen_at,
      'repeats', repeats,
      'delivery_state', delivery_state,
      'delivery_attempts', delivery_attempts,
      'delivered_at', delivered_at,
      'delivery_error', delivery_error,
      'acknowledged_at', acknowledged_at,
      -- The role, never the person: who acknowledged it is in the audit log,
      -- which is where an identity belongs.
      'acknowledged_role', acknowledged_role,
      'acknowledge_reason', acknowledge_reason
    ) AS row
    FROM admin.notifications
    ORDER BY created_at DESC
    LIMIT v_limit
  ) recent;

  SELECT jsonb_agg(entry ORDER BY ord) INTO v_sources FROM (
    SELECT 1 AS ord, jsonb_build_object(
      'key', 'alerts',
      'state', CASE WHEN v_host_run >= now() - v_stale THEN 'connected' ELSE 'not_connected' END,
      'scan', 'host',
      'last_scan_at', v_host_run,
      'open', (SELECT count(*) FROM admin.notifications WHERE source = 'alerts' AND acknowledged_at IS NULL)
    ) AS entry
    UNION ALL
    SELECT 2, jsonb_build_object(
      'key', 'backup_failure',
      'state', CASE WHEN v_host_run >= now() - v_stale THEN 'connected' ELSE 'not_connected' END,
      'scan', 'host',
      'last_scan_at', v_host_run,
      'open', (SELECT count(*) FROM admin.notifications WHERE source = 'backup_failure' AND acknowledged_at IS NULL)
    )
    UNION ALL
    SELECT 3, jsonb_build_object(
      'key', 'approval_queue',
      'state', CASE
        WHEN to_regclass('public.account_risk_levels') IS NULL THEN 'not_connected'
        WHEN v_db_run >= now() - v_stale THEN 'connected' ELSE 'not_connected' END,
      'scan', 'database',
      'last_scan_at', v_db_run,
      'open', (SELECT count(*) FROM admin.notifications WHERE source = 'approval_queue' AND acknowledged_at IS NULL)
    )
    UNION ALL
    SELECT 4, jsonb_build_object(
      'key', 'economy_anomalies',
      'state', CASE
        WHEN to_regclass('public.hero_economy_ledger') IS NULL THEN 'not_connected'
        WHEN v_db_run >= now() - v_stale THEN 'connected' ELSE 'not_connected' END,
      'scan', 'database',
      'last_scan_at', v_db_run,
      'open', (SELECT count(*) FROM admin.notifications WHERE source = 'economy_anomalies' AND acknowledged_at IS NULL)
    )
    UNION ALL
    -- The weekly report is a source like the others, but what makes it healthy
    -- is not a scan that ran minutes ago: it is a week that was actually
    -- reported. Three weeks without one means the dispatcher stopped, so it
    -- reads as not connected rather than as a quiet queue.
    SELECT 5, jsonb_build_object(
      'key', 'weekly_report',
      'state', CASE
        WHEN to_regclass('admin.report_runs') IS NULL THEN 'not_connected'
        WHEN EXISTS (
          SELECT 1 FROM admin.report_runs
          WHERE kind = 'weekly' AND generated_at >= now() - interval '21 days'
        ) THEN 'connected'
        ELSE 'not_connected' END,
      'scan', 'database',
      'last_scan_at', (SELECT max(generated_at) FROM admin.report_runs WHERE kind = 'weekly'),
      'open', (SELECT count(*) FROM admin.notifications WHERE source = 'weekly_report' AND acknowledged_at IS NULL)
    )
  ) sources;

  RETURN jsonb_build_object(
    'version', 'notifications.v2',
    'as_of', now(),
    'timezone', 'UTC',
    'stale_after_minutes', 30,
    'counts', v_counts,
    'sources', v_sources,
    'last_scan', jsonb_build_object('host', v_host_run, 'database', v_db_run),
    'items', v_items
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_feed(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.notification_feed(integer) TO heroloop_admin;

COMMENT ON FUNCTION admin.notification_feed(integer) IS
  'The Founder notification queue: counts, per-source state including the weekly report, and the recent alerts. Carries a role, never an identity, and never a player.';
