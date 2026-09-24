\set ON_ERROR_STOP on

-- Founder notifications for the Control Center
-- (docs/game/founder-control-center-v2-tz.md, Platform and Governance).
--
-- Until now the panel could only say that a Telegram channel existed. This is
-- the queue behind it: one row per condition worth the Founder's attention,
-- held to the same discipline as the rest of this schema. The text is written by
-- the server, a player id, address or key cannot be put in it at all (the check
-- constraints refuse those shapes), the same condition does not alert twice
-- inside its own cooldown, and nothing here can send: delivery is a root-side
-- timer that reads this queue, sends through the existing alert wrapper and
-- writes the result back.
--
-- Acknowledging is not resolving. It records that the Founder saw the alert and
-- why they set it aside; the row is never edited or deleted.

CREATE TABLE IF NOT EXISTS admin.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The last time a scan still saw this condition, and how often it did. A
  -- standing problem keeps one ageing row instead of a fresh alert every run.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  repeats integer NOT NULL DEFAULT 0,
  source text NOT NULL CHECK (source IN ('alerts', 'approval_queue', 'backup_failure', 'economy_anomalies')),
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  -- Names the condition, not the occurrence: this is what dedupe compares.
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-z][a-z0-9_:.-]{2,79}$'),
  title text NOT NULL,
  body text NOT NULL,
  delivery_state text NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  delivery_attempts integer NOT NULL DEFAULT 0,
  delivery_claimed_at timestamptz,
  delivered_at timestamptz,
  delivery_error text CHECK (delivery_error IS NULL OR char_length(delivery_error) <= 200),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES admin.identities(id),
  acknowledged_role text CHECK (acknowledged_role IS NULL OR acknowledged_role IN ('founder', 'operations_support', 'analyst')),
  acknowledge_reason text CHECK (acknowledge_reason IS NULL OR char_length(acknowledge_reason) <= 500),
  -- The text is written by this plane and read on a phone. An address, an id, a
  -- wallet or a token has no reason to appear in it, so the shapes are refused
  -- by the table rather than by whoever adds the next source: no '@' at all, and
  -- no run of 26 or more Latin letters and digits, which is what an id, a key or
  -- a wallet looks like. Numbers, percentages and unit names still pass.
  CONSTRAINT notifications_text_length CHECK (
    char_length(title) BETWEEN 3 AND 120 AND char_length(body) BETWEEN 3 AND 400
  ),
  CONSTRAINT notifications_text_carries_no_contact CHECK (
    position('@' IN title) = 0 AND position('@' IN body) = 0
  ),
  CONSTRAINT notifications_text_carries_no_identifier CHECK (
    title !~ '[A-Za-z0-9]{26}' AND body !~ '[A-Za-z0-9]{26}'
  )
);

CREATE INDEX IF NOT EXISTS notifications_created_idx ON admin.notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_dedupe_idx ON admin.notifications(dedupe_key, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_delivery_idx ON admin.notifications(delivery_state, created_at);

COMMENT ON TABLE admin.notifications IS
  'Founder notification queue: one row per condition worth attention, server-authored text that cannot carry player data, deduplicated per condition, acknowledged with a reason and never edited or deleted.';

-- When each scan last ran, so the panel can tell "nothing is wrong" from
-- "nobody looked". A source whose scan has stopped running is reported as not
-- connected, exactly as a missing table is elsewhere in this schema.
CREATE TABLE IF NOT EXISTS admin.notification_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('host', 'database')),
  recorded integer NOT NULL DEFAULT 0,
  suppressed integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS notification_runs_kind_idx ON admin.notification_runs(kind, ran_at DESC);

COMMENT ON TABLE admin.notification_runs IS
  'One row per notification scan, so a quiet queue can be told apart from a scan that stopped running.';

-- Records one finding, or notes that a known one is still there. The cooldown is
-- the caller's because the conditions differ in kind: a failed timer should
-- speak up again the same day, a standing queue of held accounts should not
-- repeat every hour.
CREATE OR REPLACE FUNCTION admin.notification_record(
  p_source text,
  p_severity text,
  p_dedupe_key text,
  p_title text,
  p_body text,
  p_cooldown_hours numeric DEFAULT 24
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_cooldown interval := make_interval(secs => least(greatest(coalesce(p_cooldown_hours, 24), 0.25), 720)::double precision * 3600);
  v_id bigint;
  v_created timestamptz;
BEGIN
  SELECT id, created_at INTO v_id, v_created FROM admin.notifications
  WHERE dedupe_key = p_dedupe_key
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_id IS NOT NULL AND v_created >= now() - v_cooldown THEN
    UPDATE admin.notifications
       SET last_seen_at = now(), repeats = repeats + 1
     WHERE id = v_id;
    RETURN jsonb_build_object('recorded', false, 'id', v_id, 'reason', 'inside_cooldown');
  END IF;

  INSERT INTO admin.notifications(source, severity, dedupe_key, title, body, delivery_state)
  VALUES (p_source, p_severity, p_dedupe_key, p_title, p_body,
          -- Informational rows stay in the panel. Only a warning or worse is
          -- worth a message on the Founder's phone.
          CASE WHEN p_severity = 'info' THEN 'suppressed' ELSE 'pending' END)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('recorded', true, 'id', v_id);
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_record(text, text, text, text, text, numeric) FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_record(text, text, text, text, text, numeric) IS
  'Records one notification unless the same condition already alerted inside its cooldown, in which case the existing row is aged instead. Called by the scans only; the panel has no route that reaches it.';

-- What only the host can see: failed timers, disk and certificate headroom, and
-- whether the verified recovery point is ageing. The dispatcher reads the
-- snapshots this panel already publishes and hands the findings over as one
-- array, so the only thing it can do to this schema is add rows that satisfy
-- every constraint above.
CREATE OR REPLACE FUNCTION admin.notification_host_findings(p_findings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_finding jsonb;
  v_result jsonb;
  v_recorded integer := 0;
  v_suppressed integer := 0;
BEGIN
  IF p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array' THEN
    RAISE EXCEPTION 'findings must be a JSON array';
  END IF;

  FOR v_finding IN SELECT value FROM jsonb_array_elements(p_findings) AS elements(value) LOOP
    IF coalesce(v_finding->>'source', '') NOT IN ('alerts', 'backup_failure') THEN
      RAISE EXCEPTION 'a host finding may only report the alerts or backup_failure source';
    END IF;
    v_result := admin.notification_record(
      v_finding->>'source',
      v_finding->>'severity',
      v_finding->>'dedupe_key',
      v_finding->>'title',
      v_finding->>'body',
      coalesce((v_finding->>'cooldown_hours')::numeric, 24)
    );
    IF (v_result->>'recorded')::boolean THEN
      v_recorded := v_recorded + 1;
    ELSE
      v_suppressed := v_suppressed + 1;
    END IF;
  END LOOP;

  INSERT INTO admin.notification_runs(kind, recorded, suppressed) VALUES ('host', v_recorded, v_suppressed);

  RETURN jsonb_build_object('kind', 'host', 'recorded', v_recorded, 'suppressed', v_suppressed);
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_host_findings(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_host_findings(jsonb) IS
  'Takes the host-side findings the database cannot see (timers, disk, certificates, recovery age) from the dispatcher timer and records them. Accepts only the alerts and backup_failure sources.';

-- What the database can see for itself: the approval queue, and the economy
-- anomaly shapes the Security read model already defines. The thresholds live
-- next to the query that applies them, and each source is probed with
-- to_regclass in its own guarded statement, so a database without the risk or
-- ledger tables reports nothing rather than reporting calm.
CREATE OR REPLACE FUNCTION admin.notification_scan()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_recorded integer := 0;
  v_suppressed integer := 0;
  v_checked text[] := ARRAY[]::text[];
  v_overdue bigint := 0;
  v_hold bigint := 0;
  v_median numeric;
  v_outliers bigint := 0;
  v_new_sources bigint := 0;
  v_self_trades bigint := 0;
BEGIN
  IF to_regclass('public.account_risk_levels') IS NOT NULL THEN
    v_checked := v_checked || 'approval_queue'::text;
    SELECT count(*) FILTER (WHERE review_deadline < now()),
           count(*) FILTER (WHERE level = 'hold')
      INTO v_overdue, v_hold
    FROM public.account_risk_levels;

    IF v_overdue > 0 THEN
      v_results := v_results || admin.notification_record('approval_queue', 'warning', 'approval_queue:overdue_reviews',
        'Overdue risk reviews',
        format('Review deadline passed for %s accounts. The review stays in place: decide in Players.', v_overdue),
        24);
    END IF;
    IF v_hold > 0 THEN
      v_results := v_results || admin.notification_record('approval_queue', 'warning', 'approval_queue:hold_accounts',
        'Accounts on hold',
        format('%s accounts are on hold: their tokens and withdrawals are stopped until a decision.', v_hold),
        168);
    END IF;
  END IF;

  IF to_regclass('public.hero_economy_ledger') IS NOT NULL THEN
    v_checked := v_checked || 'economy_anomalies'::text;
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) INTO v_median
    FROM public.hero_economy_ledger WHERE occurred_at >= now() - interval '7 days';

    SELECT count(*) FILTER (WHERE v_median IS NOT NULL AND v_median > 0 AND amount >= v_median * 10)
      INTO v_outliers
    FROM public.hero_economy_ledger WHERE occurred_at >= now() - interval '7 days';

    SELECT count(*) INTO v_new_sources FROM (
      SELECT source_kind FROM public.hero_economy_ledger
      GROUP BY source_kind HAVING min(occurred_at) >= now() - interval '7 days'
    ) fresh;

    IF v_outliers > 0 THEN
      v_results := v_results || admin.notification_record('economy_anomalies', 'warning', 'economy:ledger_outliers',
        'Large ledger credits',
        format('%s entries in 7 days at least 10 times above normal. Amounts and recipients stay under Economy.', v_outliers),
        24);
    END IF;
    IF v_new_sources > 0 THEN
      v_results := v_results || admin.notification_record('economy_anomalies', 'warning', 'economy:new_ledger_source',
        'New credit source',
        format('%s new sources appeared in the ledger: either a new release or something undeclared is writing to the ledger.', v_new_sources),
        24);
    END IF;
  END IF;

  IF to_regclass('public.market_item_listings') IS NOT NULL THEN
    SELECT count(*) INTO v_self_trades
    FROM public.market_item_listings
    WHERE status = 'sold' AND completed_at >= now() - interval '7 days'
      AND buyer_id IS NOT NULL AND buyer_id = seller_id;

    IF v_self_trades > 0 THEN
      v_results := v_results || admin.notification_record('economy_anomalies', 'critical', 'economy:market_self_trades',
        'Self-trades on the Market',
        format('%s sales in 7 days where buyer and seller are the same account. This moves gold around rather than trading.', v_self_trades),
        24);
    END IF;
  END IF;

  SELECT count(*) FILTER (WHERE (entry->>'recorded')::boolean),
         count(*) FILTER (WHERE NOT (entry->>'recorded')::boolean)
    INTO v_recorded, v_suppressed
  FROM jsonb_array_elements(v_results) AS entries(entry);

  INSERT INTO admin.notification_runs(kind, recorded, suppressed) VALUES ('database', v_recorded, v_suppressed);

  RETURN jsonb_build_object(
    'kind', 'database',
    'recorded', v_recorded,
    'suppressed', v_suppressed,
    'checked', to_jsonb(v_checked),
    'approval_queue', jsonb_build_object('overdue_reviews', v_overdue, 'hold_accounts', v_hold),
    'economy', jsonb_build_object('ledger_outliers', v_outliers, 'new_sources', v_new_sources, 'market_self_trades', v_self_trades)
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_scan() FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_scan() IS
  'Evaluates the database-side notification sources (approval queue, economy anomalies) against fixed thresholds and records what it finds. Aggregates only: no row it writes can name a player.';

-- The queue as the panel shows it: counts, per-source state and the recent rows.
-- Counts only and server text only, so there is nothing here to redact.
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
  ) sources;

  RETURN jsonb_build_object(
    'version', 'notifications.v1',
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
GRANT SELECT ON admin.notifications, admin.notification_runs TO heroloop_admin;

COMMENT ON FUNCTION admin.notification_feed(integer) IS
  'The Founder notification queue for the panel: counts, per-source state (a scan that stopped running reads not connected) and the recent rows. Read-only, server text only, no identity.';

-- Acknowledging records that the Founder saw an alert and why they set it
-- aside. It is not a fix and it does not close anything: the condition is still
-- whatever the next scan finds.
CREATE OR REPLACE FUNCTION admin.notification_acknowledge(
  p_id bigint,
  p_identity uuid,
  p_role text,
  p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_row admin.notifications;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'a reason of at least three characters is required';
  END IF;

  SELECT * INTO v_row FROM admin.notifications WHERE id = p_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_notification');
  END IF;

  IF v_row.acknowledged_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'id', v_row.id,
      'acknowledged_at', v_row.acknowledged_at, 'acknowledged_role', v_row.acknowledged_role);
  END IF;

  UPDATE admin.notifications
     SET acknowledged_at = now(),
         acknowledged_by = p_identity,
         acknowledged_role = p_role,
         acknowledge_reason = btrim(p_reason)
   WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'already', false, 'id', v_row.id,
    'acknowledged_at', v_row.acknowledged_at, 'acknowledged_role', v_row.acknowledged_role);
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_acknowledge(bigint, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.notification_acknowledge(bigint, uuid, text, text) TO heroloop_admin;

COMMENT ON FUNCTION admin.notification_acknowledge(bigint, uuid, text, text) IS
  'Marks one notification as seen, with a reason. Idempotent: an already acknowledged row keeps its first reason. Acknowledging is not resolving and deletes nothing.';

-- Delivery, claimed in small batches so a burst cannot turn into a flood of
-- messages, and so two overlapping runs cannot send the same row twice. A row
-- left in 'sending' by an interrupted run is retried after ten minutes; after
-- three failed attempts it stops being retried and stays visible as failed.
CREATE OR REPLACE FUNCTION admin.notification_claim_delivery(p_limit integer DEFAULT 5)
RETURNS TABLE(id bigint, severity text, title text, body text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT n.id FROM admin.notifications n
    WHERE n.delivery_attempts < 3
      AND (n.delivery_state = 'pending'
        OR (n.delivery_state = 'sending' AND n.delivery_claimed_at < now() - interval '10 minutes'))
    ORDER BY n.created_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE admin.notifications n
     SET delivery_state = 'sending',
         delivery_attempts = n.delivery_attempts + 1,
         delivery_claimed_at = now()
    FROM claimable c
   WHERE n.id = c.id
  RETURNING n.id, n.severity, n.title, n.body;
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_claim_delivery(integer) FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_claim_delivery(integer) IS
  'Claims up to a few undelivered notifications for the dispatcher timer, so overlapping runs cannot send the same alert twice and a burst cannot become a flood.';

CREATE OR REPLACE FUNCTION admin.notification_delivery_result(
  p_id bigint,
  p_sent boolean,
  p_error text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_row admin.notifications;
BEGIN
  UPDATE admin.notifications
     SET delivery_state = CASE
           WHEN p_sent THEN 'sent'
           WHEN delivery_attempts >= 3 THEN 'failed'
           ELSE 'pending' END,
         delivered_at = CASE WHEN p_sent THEN now() ELSE delivered_at END,
         delivery_error = CASE WHEN p_sent THEN NULL ELSE left(coalesce(p_error, 'delivery failed'), 200) END
   WHERE id = p_id
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_notification');
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_row.id, 'delivery_state', v_row.delivery_state);
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_delivery_result(bigint, boolean, text) FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_delivery_result(bigint, boolean, text) IS
  'Writes back what the dispatcher timer got from the alert wrapper: sent, or the error, with a third failed attempt ending the retries and staying visible in the panel.';

-- Replaces the series from 20260924200000 with the same facts plus the
-- notification queue: how many alerts each day raised and how many of them
-- reached the Founder's phone. Both are counted facts, so a day with none is a
-- zero rather than a gap.
CREATE OR REPLACE FUNCTION admin.timeseries(p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from date := (now() AT TIME ZONE 'UTC')::date - (v_days - 1);
  v_series jsonb := '{}'::jsonb;
  v_since timestamptz;
BEGIN
  SELECT min(sampled_at) INTO v_since FROM admin.activity_samples;

  WITH days AS (
    SELECT generate_series(v_from, (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day
  ),
  signups AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM auth.users WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  issuance AS (
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
           round(sum(amount) FILTER (WHERE flow = 'player_issuance'), 2) AS issued,
           round(sum(amount) FILTER (WHERE flow = 'treasury_inflow'), 2) AS treasury,
           count(*) AS entries
    FROM public.hero_economy_ledger
    WHERE (occurred_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  summons AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n, coalesce(sum(summon_count), 0) AS heroes
    FROM public.summon_events WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  risk AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM public.account_risk_events WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  audit AS (
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS n,
           count(*) FILTER (WHERE outcome = 'failure') AS refused
    FROM admin.audit_log WHERE (occurred_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  deletions AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM admin.account_deletions WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  notifications AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
           count(*) AS raised,
           count(*) FILTER (WHERE delivery_state = 'sent') AS delivered
    FROM admin.notifications WHERE (created_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  ),
  activity AS (
    SELECT (sampled_at AT TIME ZONE 'UTC')::date AS day,
           max(online_now) AS online_peak,
           max(active_24h) AS active_24h,
           round(min(disk_free_pct), 1) AS disk_free_pct,
           round(min(memory_free_pct), 1) AS memory_free_pct
    FROM admin.activity_samples
    WHERE (sampled_at AT TIME ZONE 'UTC')::date >= v_from GROUP BY 1
  )
  SELECT jsonb_build_object(
    'days', coalesce(jsonb_agg(to_char(d.day, 'YYYY-MM-DD') ORDER BY d.day), '[]'::jsonb),
    'signups', coalesce(jsonb_agg(coalesce(s.n, 0) ORDER BY d.day), '[]'::jsonb),
    'tokens_issued', coalesce(jsonb_agg(coalesce(i.issued, 0) ORDER BY d.day), '[]'::jsonb),
    'tokens_to_treasury', coalesce(jsonb_agg(coalesce(i.treasury, 0) ORDER BY d.day), '[]'::jsonb),
    'ledger_entries', coalesce(jsonb_agg(coalesce(i.entries, 0) ORDER BY d.day), '[]'::jsonb),
    'summons', coalesce(jsonb_agg(coalesce(su.n, 0) ORDER BY d.day), '[]'::jsonb),
    'heroes_summoned', coalesce(jsonb_agg(coalesce(su.heroes, 0) ORDER BY d.day), '[]'::jsonb),
    'risk_changes', coalesce(jsonb_agg(coalesce(r.n, 0) ORDER BY d.day), '[]'::jsonb),
    'admin_actions', coalesce(jsonb_agg(coalesce(a.n, 0) ORDER BY d.day), '[]'::jsonb),
    'admin_refusals', coalesce(jsonb_agg(coalesce(a.refused, 0) ORDER BY d.day), '[]'::jsonb),
    'account_deletions', coalesce(jsonb_agg(coalesce(del.n, 0) ORDER BY d.day), '[]'::jsonb),
    'notifications_raised', coalesce(jsonb_agg(coalesce(nt.raised, 0) ORDER BY d.day), '[]'::jsonb),
    'notifications_delivered', coalesce(jsonb_agg(coalesce(nt.delivered, 0) ORDER BY d.day), '[]'::jsonb),
    'online_peak', coalesce(jsonb_agg(act.online_peak ORDER BY d.day), '[]'::jsonb),
    'active_24h', coalesce(jsonb_agg(act.active_24h ORDER BY d.day), '[]'::jsonb),
    'disk_free_pct', coalesce(jsonb_agg(act.disk_free_pct ORDER BY d.day), '[]'::jsonb),
    'memory_free_pct', coalesce(jsonb_agg(act.memory_free_pct ORDER BY d.day), '[]'::jsonb)
  ) INTO v_series
  FROM days d
  LEFT JOIN signups s ON s.day = d.day
  LEFT JOIN issuance i ON i.day = d.day
  LEFT JOIN summons su ON su.day = d.day
  LEFT JOIN risk r ON r.day = d.day
  LEFT JOIN audit a ON a.day = d.day
  LEFT JOIN deletions del ON del.day = d.day
  LEFT JOIN notifications nt ON nt.day = d.day
  LEFT JOIN activity act ON act.day = d.day;

  RETURN jsonb_build_object(
    'version', 'timeseries.v3',
    'as_of', now(),
    'timezone', 'UTC',
    'days_requested', v_days,
    'series', v_series,
    'activity_collecting_since', v_since,
    'not_tracked', CASE WHEN v_since IS NULL
      THEN jsonb_build_array('daily_active_players', 'concurrent_players')
      ELSE jsonb_build_array() END
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.timeseries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.timeseries(integer) TO heroloop_admin;

-- Acknowledging an alert is a founder action with its own consequence - a
-- warning stops being new - so it gets its own audit kind instead of hiding
-- inside view_access. Without this the audit row would be refused by the check
-- constraint and the route would fail closed.
DO $audit_kinds$
DECLARE
  v_constraint text;
BEGIN
  SELECT conname INTO v_constraint FROM pg_constraint
  WHERE conrelid = 'admin.audit_log'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%event_kind%';
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE admin.audit_log DROP CONSTRAINT %I', v_constraint);
  END IF;
  ALTER TABLE admin.audit_log ADD CONSTRAINT audit_log_event_kind_check CHECK (event_kind IN (
    'login_identity', 'login_passkey', 'passkey_enroll', 'step_up', 'view_access', 'allowlist_change',
    'player_search', 'player_view', 'player_unmask', 'support_note', 'player_operation',
    'analytics_export', 'account_deletion', 'notification_acknowledge'
  ));
END
$audit_kinds$;
