\set ON_ERROR_STOP on

-- Support tickets for the Founder Control Center
-- (docs/game/founder-control-center-v2-tz.md, "Support tickets").
--
-- The game has no in-game support form and no channel back to a player, so a
-- ticket is what staff write down when a player reaches out anywhere else
-- (Telegram, Discord, mail, X): the channel, an optional link to the player's
-- card, a subject, a priority and the deadlines that priority sets. Everything
-- after that is one more timeline row: a note, a status change, a reply draft.
--
-- A reply to a player is external communication, so it is only ever a draft
-- here until a founder approves it. Approving does not send: the panel has no
-- channel to a player. The founder sends the approved text by hand where the
-- player wrote and records that it went out; only then does the ticket count
-- as answered.
--
-- Nothing is edited or deleted - the panel role can only read both tables and
-- write through the functions below. Text is staff's own summary, not a paste:
-- an address or an identifier-shaped run is refused, and the player link is a
-- checked id in its own column, never text.

CREATE TABLE IF NOT EXISTS admin.support_tickets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES admin.identities(id),
  channel text NOT NULL CHECK (channel IN ('telegram', 'discord', 'email', 'x', 'other')),
  player_id uuid,
  subject text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  first_response_due_at timestamptz NOT NULL,
  resolve_due_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT support_tickets_subject_length CHECK (char_length(subject) BETWEEN 3 AND 120),
  CONSTRAINT support_tickets_subject_carries_no_contact CHECK (position('@' IN subject) = 0),
  CONSTRAINT support_tickets_subject_carries_no_identifier CHECK (subject !~ '[A-Za-z0-9]{26}')
);
CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON admin.support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_player_idx ON admin.support_tickets(player_id) WHERE player_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin.support_ticket_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id bigint NOT NULL REFERENCES admin.support_tickets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  actor_role text NOT NULL CHECK (actor_role IN ('founder', 'operations_support', 'analyst')),
  kind text NOT NULL CHECK (kind IN ('opened', 'note', 'status', 'reply_draft', 'reply_approved', 'reply_rejected', 'reply_sent')),
  status text CHECK (status IS NULL OR status IN ('new', 'in_progress', 'waiting_player', 'resolved', 'closed')),
  -- A decision or a send names the draft it is about.
  reply_event_id bigint REFERENCES admin.support_ticket_events(id),
  template_key text CHECK (template_key IS NULL OR template_key ~ '^[a-z][a-z0-9_]{2,40}$'),
  body text,
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT support_ticket_events_status_only_on_status CHECK ((kind = 'status') = (status IS NOT NULL)),
  CONSTRAINT support_ticket_events_reply_link CHECK (
    (kind IN ('reply_approved', 'reply_rejected', 'reply_sent')) = (reply_event_id IS NOT NULL)
  ),
  CONSTRAINT support_ticket_events_body_length CHECK (body IS NULL OR char_length(body) BETWEEN 3 AND 2000),
  CONSTRAINT support_ticket_events_body_carries_no_contact CHECK (body IS NULL OR position('@' IN body) = 0),
  CONSTRAINT support_ticket_events_body_carries_no_identifier CHECK (body IS NULL OR body !~ '[A-Za-z0-9]{26}')
);
CREATE INDEX IF NOT EXISTS support_ticket_events_ticket_idx ON admin.support_ticket_events(ticket_id, created_at, id);

COMMENT ON TABLE admin.support_tickets IS
  'Support tickets written by staff from outside channels: channel, optional checked player link, subject, priority and SLA deadlines; never edited or deleted.';
COMMENT ON TABLE admin.support_ticket_events IS
  'Append-only ticket timeline: notes, status changes, reply drafts and the founder decision and manual send for each draft.';

-- Staff who may work tickets: founder and operations support. The analyst role
-- reads aggregates and has no business in one player's conversation.
CREATE OR REPLACE FUNCTION admin.support_ticket_actor(p_actor uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM admin.identities WHERE id = p_actor AND status = 'active';
  IF v_role IS NULL OR v_role NOT IN ('founder', 'operations_support') THEN
    RAISE EXCEPTION 'support_role_required' USING ERRCODE = '22023';
  END IF;
  RETURN v_role;
END
$function$;

CREATE OR REPLACE FUNCTION admin.support_ticket_text(p_text text, p_min integer, p_max integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_text text := btrim(coalesce(p_text, ''));
BEGIN
  IF char_length(v_text) NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION 'invalid_ticket_text' USING ERRCODE = '22023';
  END IF;
  IF position('@' IN v_text) > 0 OR v_text ~ '[A-Za-z0-9]{26}' THEN
    RAISE EXCEPTION 'ticket_text_carries_identifier' USING ERRCODE = '22023';
  END IF;
  RETURN v_text;
END
$function$;

-- Hours to first response and to resolution, per priority. One place, so the
-- screen and the queue can never disagree about what "overdue" means.
CREATE OR REPLACE FUNCTION admin.support_ticket_sla(p_priority text)
RETURNS jsonb LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE p_priority
    WHEN 'urgent' THEN '{"first_response_hours": 1, "resolve_hours": 8}'::jsonb
    WHEN 'high' THEN '{"first_response_hours": 4, "resolve_hours": 24}'::jsonb
    WHEN 'normal' THEN '{"first_response_hours": 24, "resolve_hours": 72}'::jsonb
    WHEN 'low' THEN '{"first_response_hours": 72, "resolve_hours": 168}'::jsonb
  END;
$function$;

CREATE OR REPLACE FUNCTION admin.support_ticket_open(
  p_actor uuid, p_channel text, p_player_id uuid, p_subject text, p_summary text, p_priority text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_role text;
  v_existing admin.support_tickets%ROWTYPE;
  v_subject text;
  v_summary text;
  v_sla jsonb;
  v_id bigint;
BEGIN
  v_role := admin.support_ticket_actor(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('telegram', 'discord', 'email', 'x', 'other') THEN
    RAISE EXCEPTION 'invalid_ticket_channel' USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NULL OR p_priority NOT IN ('urgent', 'high', 'normal', 'low') THEN
    RAISE EXCEPTION 'invalid_ticket_priority' USING ERRCODE = '22023';
  END IF;
  v_subject := admin.support_ticket_text(p_subject, 3, 120);
  v_summary := admin.support_ticket_text(p_summary, 3, 2000);
  -- A link to a player who does not exist would send the next reader to an
  -- empty card; it is refused instead of stored.
  IF p_player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id) THEN
    RAISE EXCEPTION 'unknown_player' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.support_tickets'));
  SELECT * INTO v_existing FROM admin.support_tickets WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.subject <> v_subject OR v_existing.channel <> p_channel OR v_existing.priority <> p_priority
       OR v_existing.player_id IS DISTINCT FROM p_player_id THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM admin.support_ticket_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
  END IF;

  v_sla := admin.support_ticket_sla(p_priority);
  INSERT INTO admin.support_tickets(created_by, channel, player_id, subject, priority, first_response_due_at, resolve_due_at, idempotency_key)
  VALUES (p_actor, p_channel, p_player_id, v_subject, p_priority,
          now() + make_interval(hours => (v_sla->>'first_response_hours')::integer),
          now() + make_interval(hours => (v_sla->>'resolve_hours')::integer),
          p_idempotency_key)
  RETURNING id INTO v_id;
  INSERT INTO admin.support_ticket_events(ticket_id, actor_identity_id, actor_role, kind, body, idempotency_key)
  VALUES (v_id, p_actor, v_role, 'opened', v_summary, gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

CREATE OR REPLACE FUNCTION admin.support_ticket_status(p_ticket_id bigint)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT coalesce((
    SELECT status FROM admin.support_ticket_events
    WHERE ticket_id = p_ticket_id AND kind = 'status'
    ORDER BY created_at DESC, id DESC LIMIT 1
  ), 'new');
$function$;

-- One more timeline row. Staff may note, change status and draft a reply; only
-- a founder may approve or reject a draft, and only a founder records that an
-- approved draft was sent. A draft is decided once and sent once.
CREATE OR REPLACE FUNCTION admin.support_ticket_record(
  p_actor uuid, p_ticket_id bigint, p_kind text, p_body text, p_status text,
  p_reply_event_id bigint, p_template_key text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_role text;
  v_existing admin.support_ticket_events%ROWTYPE;
  v_draft admin.support_ticket_events%ROWTYPE;
  v_body text;
  v_id bigint;
BEGIN
  v_role := admin.support_ticket_actor(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('note', 'status', 'reply_draft', 'reply_approved', 'reply_rejected', 'reply_sent') THEN
    RAISE EXCEPTION 'invalid_ticket_event' USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('reply_approved', 'reply_rejected', 'reply_sent') AND v_role <> 'founder' THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;

  -- Notes and drafts need text; a decision may carry a short why; a status
  -- change and a send carry none.
  IF p_kind IN ('note', 'reply_draft') THEN
    v_body := admin.support_ticket_text(p_body, 3, 2000);
  ELSIF p_kind IN ('reply_approved', 'reply_rejected') AND nullif(btrim(coalesce(p_body, '')), '') IS NOT NULL THEN
    v_body := admin.support_ticket_text(p_body, 3, 500);
  END IF;
  IF p_kind = 'status' AND (p_status IS NULL OR p_status NOT IN ('new', 'in_progress', 'waiting_player', 'resolved', 'closed')) THEN
    RAISE EXCEPTION 'invalid_ticket_status' USING ERRCODE = '22023';
  END IF;
  IF p_template_key IS NOT NULL AND (p_kind <> 'reply_draft' OR p_template_key !~ '^[a-z][a-z0-9_]{2,40}$') THEN
    RAISE EXCEPTION 'invalid_ticket_template' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.support_tickets'));
  IF NOT EXISTS (SELECT 1 FROM admin.support_tickets WHERE id = p_ticket_id) THEN
    RAISE EXCEPTION 'unknown_ticket' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM admin.support_ticket_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.ticket_id <> p_ticket_id OR v_existing.kind <> p_kind
       OR v_existing.body IS DISTINCT FROM v_body OR v_existing.status IS DISTINCT FROM (CASE WHEN p_kind = 'status' THEN p_status END)
       OR v_existing.reply_event_id IS DISTINCT FROM (CASE WHEN p_kind IN ('reply_approved', 'reply_rejected', 'reply_sent') THEN p_reply_event_id END) THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'ticket_id', p_ticket_id, 'replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM admin.support_tickets WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'status' AND admin.support_ticket_status(p_ticket_id) = p_status THEN
    RAISE EXCEPTION 'ticket_status_unchanged' USING ERRCODE = '22023';
  END IF;

  IF p_kind IN ('reply_approved', 'reply_rejected', 'reply_sent') THEN
    SELECT * INTO v_draft FROM admin.support_ticket_events
    WHERE id = p_reply_event_id AND ticket_id = p_ticket_id AND kind = 'reply_draft';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown_reply_draft' USING ERRCODE = '22023';
    END IF;
    IF p_kind IN ('reply_approved', 'reply_rejected') AND EXISTS (
      SELECT 1 FROM admin.support_ticket_events WHERE reply_event_id = v_draft.id AND kind IN ('reply_approved', 'reply_rejected')
    ) THEN
      RAISE EXCEPTION 'reply_already_decided' USING ERRCODE = '22023';
    END IF;
    IF p_kind = 'reply_sent' THEN
      IF NOT EXISTS (SELECT 1 FROM admin.support_ticket_events WHERE reply_event_id = v_draft.id AND kind = 'reply_approved') THEN
        RAISE EXCEPTION 'reply_not_approved' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM admin.support_ticket_events WHERE reply_event_id = v_draft.id AND kind = 'reply_sent') THEN
        RAISE EXCEPTION 'reply_already_sent' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  INSERT INTO admin.support_ticket_events(ticket_id, actor_identity_id, actor_role, kind, status, reply_event_id, template_key, body, idempotency_key)
  VALUES (p_ticket_id, p_actor, v_role, p_kind,
          CASE WHEN p_kind = 'status' THEN p_status END,
          CASE WHEN p_kind IN ('reply_approved', 'reply_rejected', 'reply_sent') THEN p_reply_event_id END,
          CASE WHEN p_kind = 'reply_draft' THEN p_template_key END,
          v_body, p_idempotency_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'ticket_id', p_ticket_id, 'replayed', false);
END
$function$;

-- Per-ticket state in one place: status, first reply sent, drafts waiting for
-- a founder, and whether either deadline has passed on a ticket still open.
CREATE OR REPLACE VIEW admin.support_ticket_state AS
  SELECT t.id,
    admin.support_ticket_status(t.id) AS status,
    (SELECT min(e.created_at) FROM admin.support_ticket_events e WHERE e.ticket_id = t.id AND e.kind = 'reply_sent') AS first_response_at,
    (SELECT count(*) FROM admin.support_ticket_events d
      WHERE d.ticket_id = t.id AND d.kind = 'reply_draft'
        AND NOT EXISTS (SELECT 1 FROM admin.support_ticket_events x WHERE x.reply_event_id = d.id AND x.kind IN ('reply_approved', 'reply_rejected'))) AS replies_awaiting_approval,
    (SELECT count(*) FROM admin.support_ticket_events a
      WHERE a.ticket_id = t.id AND a.kind = 'reply_approved'
        AND NOT EXISTS (SELECT 1 FROM admin.support_ticket_events s WHERE s.reply_event_id = a.reply_event_id AND s.kind = 'reply_sent')) AS replies_awaiting_send
  FROM admin.support_tickets t;

CREATE OR REPLACE FUNCTION admin.support_ticket_counts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT jsonb_build_object(
    'total', count(*),
    'open', count(*) FILTER (WHERE s.status NOT IN ('resolved', 'closed')),
    'new', count(*) FILTER (WHERE s.status = 'new'),
    'waiting_player', count(*) FILTER (WHERE s.status = 'waiting_player'),
    'first_response_overdue', count(*) FILTER (WHERE s.status NOT IN ('resolved', 'closed') AND s.first_response_at IS NULL AND t.first_response_due_at < now()),
    'resolve_overdue', count(*) FILTER (WHERE s.status NOT IN ('resolved', 'closed') AND t.resolve_due_at < now()),
    'replies_awaiting_approval', coalesce(sum(s.replies_awaiting_approval), 0),
    'replies_awaiting_send', coalesce(sum(s.replies_awaiting_send), 0),
    'opened_7d', count(*) FILTER (WHERE t.created_at >= now() - interval '7 days'),
    'next_due_at', min(least(CASE WHEN s.first_response_at IS NULL THEN t.first_response_due_at END, t.resolve_due_at))
      FILTER (WHERE s.status NOT IN ('resolved', 'closed'))
  )
  FROM admin.support_tickets t JOIN admin.support_ticket_state s ON s.id = t.id;
$function$;

CREATE OR REPLACE FUNCTION admin.support_ticket_list(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT jsonb_build_object(
    'as_of', now(),
    'counts', admin.support_ticket_counts(),
    'tickets', coalesce((
      SELECT jsonb_agg(item ORDER BY created_at DESC, id DESC)
      FROM (
        SELECT t.id, t.created_at, jsonb_build_object(
          'id', t.id,
          'created_at', t.created_at,
          'channel', t.channel,
          'player_id', t.player_id,
          'subject', t.subject,
          'priority', t.priority,
          'status', s.status,
          'first_response_due_at', t.first_response_due_at,
          'resolve_due_at', t.resolve_due_at,
          'first_response_at', s.first_response_at,
          'first_response_overdue', s.status NOT IN ('resolved', 'closed') AND s.first_response_at IS NULL AND t.first_response_due_at < now(),
          'resolve_overdue', s.status NOT IN ('resolved', 'closed') AND t.resolve_due_at < now(),
          'replies_awaiting_approval', s.replies_awaiting_approval,
          'replies_awaiting_send', s.replies_awaiting_send,
          -- The role, never the person: who wrote each row is in the audit log.
          'events', (
            SELECT jsonb_agg(jsonb_build_object(
              'id', e.id, 'created_at', e.created_at, 'kind', e.kind, 'status', e.status,
              'reply_event_id', e.reply_event_id, 'template_key', e.template_key, 'body', e.body, 'actor_role', e.actor_role
            ) ORDER BY e.created_at, e.id)
            FROM admin.support_ticket_events e WHERE e.ticket_id = t.id
          )
        ) AS item
        FROM admin.support_tickets t JOIN admin.support_ticket_state s ON s.id = t.id
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT least(greatest(coalesce(p_limit, 100), 1), 200)
      ) newest
    ), '[]'::jsonb)
  );
$function$;

-- The Overview queue gains ticket counts. Counts only: no subject, no player.
CREATE OR REPLACE FUNCTION admin.support_queue()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_levels jsonb;
  v_overdue bigint;
  v_next_deadline timestamptz;
  v_changes_7d bigint;
  v_notes_total bigint;
  v_notes_7d bigint;
  v_last_note timestamptz;
  v_operations_7d bigint;
  v_incidents jsonb;
  v_tickets jsonb;
BEGIN
  SELECT jsonb_build_object(
    'watch', count(*) FILTER (WHERE level = 'watch'),
    'review', count(*) FILTER (WHERE level = 'review'),
    'hold', count(*) FILTER (WHERE level = 'hold')
  ) INTO v_levels FROM public.account_risk_levels;

  SELECT count(*) FILTER (WHERE review_deadline < now()), min(review_deadline) FILTER (WHERE review_deadline >= now())
  INTO v_overdue, v_next_deadline
  FROM public.account_risk_levels;

  SELECT count(*) INTO v_changes_7d
  FROM public.account_risk_events WHERE created_at >= now() - interval '7 days';

  SELECT count(*), count(*) FILTER (WHERE created_at >= now() - interval '7 days'), max(created_at)
  INTO v_notes_total, v_notes_7d, v_last_note
  FROM admin.support_notes;

  SELECT count(*) INTO v_operations_7d
  FROM admin.player_operations WHERE created_at >= now() - interval '7 days';

  v_incidents := admin.incident_counts();
  v_tickets := admin.support_ticket_counts();

  RETURN jsonb_build_object(
    'as_of', now(),
    'risk_levels', v_levels,
    'risk_overdue_reviews', v_overdue,
    'risk_next_review_at', v_next_deadline,
    'risk_changes_7d', v_changes_7d,
    'support_notes_total', v_notes_total,
    'support_notes_7d', v_notes_7d,
    'support_last_note_at', v_last_note,
    'support_operations_7d', v_operations_7d,
    'incidents', jsonb_build_object(
      'open', v_incidents->'open',
      'open_sev1', v_incidents->'open_sev1',
      'last_opened_at', v_incidents->'last_opened_at'
    ),
    'tickets', jsonb_build_object(
      'open', v_tickets->'open',
      'first_response_overdue', v_tickets->'first_response_overdue',
      'resolve_overdue', v_tickets->'resolve_overdue',
      'replies_awaiting_approval', v_tickets->'replies_awaiting_approval'
    ),
    'approvals', 'not_tracked'
  );
END
$function$;

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
    'analytics_export', 'account_deletion', 'notification_acknowledge', 'todo_action', 'feature_flag_change',
    'simulation_run', 'incident_record', 'support_ticket'
  ));
END
$audit_kinds$;

-- Append-only by privilege: the panel role writes only through the checked
-- functions, and reads tickets only through the list (the tables hold player
-- links the analyst role must not reach by a plain SELECT).
REVOKE ALL ON admin.support_tickets, admin.support_ticket_events, admin.support_ticket_state FROM PUBLIC;

REVOKE ALL ON FUNCTION admin.support_ticket_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_text(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_sla(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_status(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_open(uuid, text, uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_record(uuid, bigint, text, text, text, bigint, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_ticket_list(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.support_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.support_ticket_open(uuid, text, uuid, text, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.support_ticket_record(uuid, bigint, text, text, text, bigint, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.support_ticket_list(integer) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.support_queue() TO heroloop_admin;

COMMENT ON FUNCTION admin.support_ticket_open(uuid, text, uuid, text, text, text, uuid) IS
  'Founder or operations support: records one ticket from an outside channel with its SLA deadlines; idempotent by key.';
COMMENT ON FUNCTION admin.support_ticket_record(uuid, bigint, text, text, text, bigint, text, uuid) IS
  'Appends a note, status change or reply draft (staff), or a reply approval, rejection or manual send (founder only); idempotent by key.';
COMMENT ON FUNCTION admin.support_ticket_list(integer) IS
  'Ticket counts and the newest tickets with SLA state and timelines; roles, never people.';
