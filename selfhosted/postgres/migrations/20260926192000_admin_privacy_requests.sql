\set ON_ERROR_STOP on

-- Player privacy requests for the Control Center Compliance screen
-- (docs/game/founder-control-center-v2-tz.md, Compliance & privacy).
--
-- A player asks, outside the game, for their data to be deleted or handed to
-- them. The Founder records the request here with the day it arrived, and the
-- queue counts down the 30 days a request may take. Recording and closing a
-- request changes nothing about the account: deletion itself stays on Player
-- Support with its own preview and evidence-hold rule, and an export has no
-- builder yet. Both tables are append-only; the current status is the latest
-- status event.
--
-- Free text carries no mail address and no long identifier, the same rule as
-- support tickets: the account link is the checked player id, never a copy of
-- the address the player wrote from.

CREATE TABLE IF NOT EXISTS admin.privacy_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES admin.identities(id),
  kind text NOT NULL CHECK (kind IN ('deletion', 'export')),
  channel text NOT NULL CHECK (channel IN ('telegram', 'discord', 'email', 'x', 'other')),
  player_id uuid,
  received_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT privacy_requests_due_after_received CHECK (due_at > received_at)
);

CREATE TABLE IF NOT EXISTS admin.privacy_request_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES admin.privacy_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  kind text NOT NULL CHECK (kind IN ('opened', 'note', 'status')),
  status text CHECK (status IS NULL OR status IN ('open', 'in_progress', 'done', 'refused')),
  body text,
  idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT privacy_request_events_status_matches_kind CHECK ((kind = 'status') = (status IS NOT NULL)),
  CONSTRAINT privacy_request_events_body_length CHECK (body IS NULL OR char_length(body) BETWEEN 3 AND 2000),
  CONSTRAINT privacy_request_events_body_carries_no_contact CHECK (body IS NULL OR position('@' IN body) = 0),
  CONSTRAINT privacy_request_events_body_carries_no_identifier CHECK (body IS NULL OR body !~ '[A-Za-z0-9]{26}')
);
CREATE INDEX IF NOT EXISTS privacy_request_events_request_idx ON admin.privacy_request_events(request_id, created_at, id);

CREATE OR REPLACE RULE privacy_requests_no_update AS ON UPDATE TO admin.privacy_requests DO INSTEAD NOTHING;
CREATE OR REPLACE RULE privacy_requests_no_delete AS ON DELETE TO admin.privacy_requests DO INSTEAD NOTHING;
CREATE OR REPLACE RULE privacy_request_events_no_update AS ON UPDATE TO admin.privacy_request_events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE privacy_request_events_no_delete AS ON DELETE TO admin.privacy_request_events DO INSTEAD NOTHING;

COMMENT ON TABLE admin.privacy_requests IS
  'Player requests to delete or export their data, recorded by the Founder: kind, channel, optional checked player link, day received and the 30-day due date; never edited or deleted.';
COMMENT ON TABLE admin.privacy_request_events IS
  'Append-only privacy request timeline: opened, notes and status changes (open, in_progress, done, refused).';

CREATE OR REPLACE FUNCTION admin.privacy_request_founder(p_actor uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin.identities WHERE id = p_actor AND status = 'active' AND role = 'founder') THEN
    RAISE EXCEPTION 'founder_role_required' USING ERRCODE = '22023';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION admin.privacy_request_status(p_request_id bigint)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT coalesce((
    SELECT status FROM admin.privacy_request_events
    WHERE request_id = p_request_id AND kind = 'status'
    ORDER BY created_at DESC, id DESC LIMIT 1
  ), 'open');
$function$;

CREATE OR REPLACE FUNCTION admin.privacy_request_open(
  p_actor uuid, p_kind text, p_channel text, p_player_id uuid, p_received_at timestamptz, p_summary text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_existing admin.privacy_requests%ROWTYPE;
  v_received timestamptz := coalesce(p_received_at, now());
  v_summary text;
  v_id bigint;
BEGIN
  PERFORM admin.privacy_request_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('deletion', 'export') THEN
    RAISE EXCEPTION 'invalid_request_kind' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('telegram', 'discord', 'email', 'x', 'other') THEN
    RAISE EXCEPTION 'invalid_ticket_channel' USING ERRCODE = '22023';
  END IF;
  -- A request recorded late keeps the day it really arrived, so the deadline is
  -- honest; it cannot come from the future or from before the game existed.
  IF v_received > now() + interval '5 minutes' OR v_received < now() - interval '60 days' THEN
    RAISE EXCEPTION 'invalid_received_at' USING ERRCODE = '22023';
  END IF;
  v_summary := admin.support_ticket_text(p_summary, 3, 2000);
  IF p_player_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id) THEN
    RAISE EXCEPTION 'unknown_player' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.privacy_requests'));
  SELECT * INTO v_existing FROM admin.privacy_requests WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.kind <> p_kind OR v_existing.channel <> p_channel OR v_existing.player_id IS DISTINCT FROM p_player_id THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;

  INSERT INTO admin.privacy_requests(created_by, kind, channel, player_id, received_at, due_at, idempotency_key)
  VALUES (p_actor, p_kind, p_channel, p_player_id, v_received, v_received + interval '30 days', p_idempotency_key)
  RETURNING id INTO v_id;
  INSERT INTO admin.privacy_request_events(request_id, actor_identity_id, kind, body, idempotency_key)
  VALUES (v_id, p_actor, 'opened', v_summary, gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

-- A note or a status change. A closed request (done or refused) takes notes
-- but no further status: reopening would hide that it was once answered, so a
-- new request is recorded instead.
CREATE OR REPLACE FUNCTION admin.privacy_request_record(
  p_actor uuid, p_request_id bigint, p_kind text, p_body text, p_status text, p_idempotency_key uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_existing admin.privacy_request_events%ROWTYPE;
  v_body text;
  v_current text;
  v_id bigint;
BEGIN
  PERFORM admin.privacy_request_founder(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('note', 'status') THEN
    RAISE EXCEPTION 'invalid_event_kind' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('heroloop.privacy_requests'));
  SELECT * INTO v_existing FROM admin.privacy_request_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_id <> p_request_id OR v_existing.kind <> p_kind OR v_existing.status IS DISTINCT FROM p_status THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM admin.privacy_requests WHERE id = p_request_id) THEN
    RAISE EXCEPTION 'unknown_request' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'note' THEN
    IF p_status IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_event_kind' USING ERRCODE = '22023';
    END IF;
    v_body := admin.support_ticket_text(p_body, 3, 2000);
  ELSE
    IF p_status IS NULL OR p_status NOT IN ('open', 'in_progress', 'done', 'refused') THEN
      RAISE EXCEPTION 'invalid_request_status' USING ERRCODE = '22023';
    END IF;
    v_current := admin.privacy_request_status(p_request_id);
    IF v_current IN ('done', 'refused') THEN
      RAISE EXCEPTION 'request_closed' USING ERRCODE = '22023';
    END IF;
    IF v_current = p_status THEN
      RAISE EXCEPTION 'status_unchanged' USING ERRCODE = '22023';
    END IF;
    -- Closing says why: what was done, or on what ground it was refused.
    IF p_status IN ('done', 'refused') THEN
      v_body := admin.support_ticket_text(p_body, 3, 2000);
    ELSIF p_body IS NOT NULL AND btrim(p_body) <> '' THEN
      v_body := admin.support_ticket_text(p_body, 3, 2000);
    END IF;
  END IF;

  INSERT INTO admin.privacy_request_events(request_id, actor_identity_id, kind, status, body, idempotency_key)
  VALUES (p_request_id, p_actor, p_kind, CASE WHEN p_kind = 'status' THEN p_status END, v_body, p_idempotency_key)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

-- Open and overdue counts per kind, for the Compliance summary.
CREATE OR REPLACE FUNCTION admin.privacy_request_counts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  WITH current AS (
    SELECT r.kind, r.due_at, admin.privacy_request_status(r.id) AS status
    FROM admin.privacy_requests r
  )
  SELECT jsonb_object_agg(
    k.kind,
    jsonb_build_object(
      'state', 'connected',
      'open', (SELECT count(*) FROM current c WHERE c.kind = k.kind AND c.status IN ('open', 'in_progress')),
      'overdue', (SELECT count(*) FROM current c WHERE c.kind = k.kind AND c.status IN ('open', 'in_progress') AND c.due_at < now()),
      'next_due_at', (SELECT min(c.due_at) FROM current c WHERE c.kind = k.kind AND c.status IN ('open', 'in_progress')),
      'closed_30d', (SELECT count(*) FROM admin.privacy_requests r
                     JOIN admin.privacy_request_events e ON e.request_id = r.id
                     WHERE r.kind = k.kind AND e.kind = 'status' AND e.status IN ('done', 'refused')
                       AND e.created_at >= now() - interval '30 days')
    )
  )
  FROM (VALUES ('deletion'), ('export')) AS k(kind)
$function$;

CREATE OR REPLACE FUNCTION admin.privacy_request_list(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT jsonb_build_object(
    'as_of', now(),
    'requests', coalesce(jsonb_agg(row_data ORDER BY closed, due_at), '[]'::jsonb)
  )
  FROM (
    SELECT
      s.status IN ('done', 'refused') AS closed,
      r.due_at,
      jsonb_build_object(
        'id', r.id,
        'kind', r.kind,
        'channel', r.channel,
        'player_id', r.player_id,
        'received_at', r.received_at,
        'due_at', r.due_at,
        'status', s.status,
        'overdue', s.status IN ('open', 'in_progress') AND r.due_at < now(),
        'events', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', e.id, 'kind', e.kind, 'status', e.status, 'body', e.body, 'created_at', e.created_at
          ) ORDER BY e.created_at, e.id), '[]'::jsonb)
          FROM admin.privacy_request_events e WHERE e.request_id = r.id
        )
      ) AS row_data
    FROM admin.privacy_requests r
    CROSS JOIN LATERAL (SELECT admin.privacy_request_status(r.id) AS status) s
    ORDER BY (s.status IN ('done', 'refused')), r.due_at
    LIMIT least(greatest(coalesce(p_limit, 100), 1), 200)
  ) q
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
    'simulation_run', 'incident_record', 'support_ticket', 'finance_record', 'privacy_request'
  ));
END
$audit_kinds$;

REVOKE ALL ON admin.privacy_requests FROM PUBLIC;
REVOKE ALL ON admin.privacy_request_events FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.privacy_request_founder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.privacy_request_status(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.privacy_request_open(uuid, text, text, uuid, timestamptz, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.privacy_request_record(uuid, bigint, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.privacy_request_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.privacy_request_list(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.privacy_request_open(uuid, text, text, uuid, timestamptz, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.privacy_request_record(uuid, bigint, text, text, text, uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.privacy_request_counts() TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.privacy_request_list(integer) TO heroloop_admin;
