\set ON_ERROR_STOP on

-- Authenticated players can open support tickets. The game API receives only
-- EXECUTE on the two narrow functions below; it gets no admin table grants.
ALTER TABLE admin.support_tickets ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE admin.support_tickets DROP CONSTRAINT support_tickets_channel_check;
ALTER TABLE admin.support_tickets ADD CONSTRAINT support_tickets_channel_check
  CHECK (channel IN ('telegram', 'discord', 'email', 'x', 'other', 'game'));
ALTER TABLE admin.support_tickets ADD COLUMN topic text;
ALTER TABLE admin.support_tickets ADD COLUMN player_priority smallint
  CONSTRAINT support_tickets_player_priority CHECK (player_priority BETWEEN 0 AND 5);
ALTER TABLE admin.support_tickets ADD CONSTRAINT support_tickets_game_origin CHECK (
  (channel = 'game' AND created_by IS NULL AND player_id IS NOT NULL AND topic IS NOT NULL AND player_priority IS NOT NULL)
  OR (channel <> 'game' AND created_by IS NOT NULL AND topic IS NULL AND player_priority IS NULL)
);
ALTER TABLE admin.support_tickets ADD CONSTRAINT support_tickets_player_fkey
  FOREIGN KEY (player_id) REFERENCES public.players(player_id) ON DELETE CASCADE;

ALTER TABLE admin.support_ticket_events ALTER COLUMN actor_identity_id DROP NOT NULL;
ALTER TABLE admin.support_ticket_events DROP CONSTRAINT support_ticket_events_actor_role_check;
ALTER TABLE admin.support_ticket_events ADD CONSTRAINT support_ticket_events_actor_role_check
  CHECK (actor_role IN ('founder', 'operations_support', 'analyst', 'player'));
ALTER TABLE admin.support_ticket_events ADD CONSTRAINT support_ticket_events_player_actor CHECK
  ((actor_role = 'player' AND actor_identity_id IS NULL AND kind = 'opened') OR actor_role <> 'player');
-- Account deletion removes the player's ticket text as well as the ticket.
-- Panel roles still have no DELETE grant; only deletion of public.players cascades.
ALTER TABLE admin.support_ticket_events DROP CONSTRAINT support_ticket_events_ticket_id_fkey;
ALTER TABLE admin.support_ticket_events ADD CONSTRAINT support_ticket_events_ticket_id_fkey
  FOREIGN KEY (ticket_id) REFERENCES admin.support_tickets(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION heroloop_api.support_ticket_submit(
  p_player_id uuid, p_key uuid, p_topic text, p_priority integer, p_body text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE
  v_topic text;
  v_subject text;
  v_body text;
  v_priority text;
  v_sla jsonb;
  v_existing admin.support_tickets%ROWTYPE;
  v_id bigint;
BEGIN
  IF p_player_id IS NULL OR p_key IS NULL THEN RAISE EXCEPTION 'invalid_support_ticket'; END IF;
  v_topic := CASE p_topic
    WHEN 'login_save' THEN 'Login and saved progress'
    WHEN 'combat' THEN 'Combat and battles'
    WHEN 'heroes' THEN 'Heroes and formation'
    WHEN 'items' THEN 'Items and inventory'
    WHEN 'rewards' THEN 'Rewards and currency'
    WHEN 'quests' THEN 'Quests and dungeons'
    WHEN 'interface' THEN 'Interface and performance'
    WHEN 'other' THEN 'Other game problem'
  END;
  IF v_topic IS NULL THEN RAISE EXCEPTION 'invalid_support_topic'; END IF;
  IF p_priority IS NULL OR p_priority NOT BETWEEN 0 AND 5 THEN RAISE EXCEPTION 'invalid_support_priority'; END IF;
  v_body := admin.support_ticket_text(p_body, 10, 2000);
  v_subject := v_topic;
  v_priority := CASE WHEN p_priority >= 4 THEN 'urgent' WHEN p_priority = 3 THEN 'high'
    WHEN p_priority = 2 THEN 'normal' ELSE 'low' END;
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id) THEN RAISE EXCEPTION 'player_not_found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('support_ticket:' || p_player_id::text, 0));
  SELECT * INTO v_existing FROM admin.support_tickets WHERE idempotency_key = p_key;
  IF FOUND THEN
    IF v_existing.channel <> 'game' OR v_existing.player_id <> p_player_id
      OR v_existing.topic <> p_topic OR v_existing.player_priority <> p_priority
      OR NOT EXISTS (SELECT 1 FROM admin.support_ticket_events e
        WHERE e.ticket_id = v_existing.id AND e.kind = 'opened' AND e.body = v_body) THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;
  IF (SELECT count(*) FROM admin.support_tickets
      WHERE channel = 'game' AND player_id = p_player_id AND created_at >= now() - interval '24 hours') >= 3 THEN
    RAISE EXCEPTION 'support_daily_limit';
  END IF;
  v_sla := admin.support_ticket_sla(v_priority);
  INSERT INTO admin.support_tickets(created_by, channel, player_id, subject, topic, player_priority,
    priority, first_response_due_at, resolve_due_at, idempotency_key)
  VALUES (NULL, 'game', p_player_id, v_subject, p_topic, p_priority, v_priority,
    now() + make_interval(hours => (v_sla->>'first_response_hours')::integer),
    now() + make_interval(hours => (v_sla->>'resolve_hours')::integer), p_key)
  RETURNING id INTO v_id;
  INSERT INTO admin.support_ticket_events(ticket_id, actor_identity_id, actor_role, kind, body, idempotency_key)
  VALUES (v_id, NULL, 'player', 'opened', v_body, gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

CREATE OR REPLACE FUNCTION heroloop_api.support_ticket_list_mine(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
  SELECT jsonb_build_object('tickets', coalesce(jsonb_agg(item ORDER BY created_at DESC, id DESC), '[]'::jsonb))
  FROM (
    SELECT t.id, t.created_at, jsonb_build_object(
      'id', t.id, 'created_at', t.created_at, 'topic', t.topic,
      'priority', t.player_priority, 'status', admin.support_ticket_status(t.id),
      'body', (SELECT e.body FROM admin.support_ticket_events e
        WHERE e.ticket_id = t.id AND e.kind = 'opened' ORDER BY e.id LIMIT 1),
      'replies', coalesce((SELECT jsonb_agg(jsonb_build_object('body', d.body, 'created_at', sent.created_at)
        ORDER BY sent.created_at, sent.id)
        FROM admin.support_ticket_events sent
        JOIN admin.support_ticket_events d ON d.id = sent.reply_event_id
        WHERE sent.ticket_id = t.id AND sent.kind = 'reply_sent' AND d.kind = 'reply_draft'), '[]'::jsonb)
    ) AS item
    FROM admin.support_tickets t WHERE t.channel = 'game' AND t.player_id = p_player_id
    ORDER BY t.created_at DESC, t.id DESC LIMIT 20
  ) recent;
$function$;

REVOKE ALL ON FUNCTION heroloop_api.support_ticket_submit(uuid,uuid,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heroloop_api.support_ticket_list_mine(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.support_ticket_submit(uuid,uuid,text,integer,text) TO heroloop_api;
GRANT EXECUTE ON FUNCTION heroloop_api.support_ticket_list_mine(uuid) TO heroloop_api;

-- Keep the Founder panel's bounded list shape and include the player's choices.
CREATE OR REPLACE FUNCTION admin.support_ticket_list(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
  SELECT jsonb_build_object(
    'as_of', now(), 'counts', admin.support_ticket_counts(),
    'tickets', coalesce((SELECT jsonb_agg(item ORDER BY created_at DESC, id DESC)
      FROM (SELECT t.id, t.created_at, jsonb_build_object(
        'id', t.id, 'created_at', t.created_at, 'channel', t.channel,
        'player_id', t.player_id, 'subject', t.subject, 'topic', t.topic,
        'player_priority', t.player_priority, 'priority', t.priority, 'status', s.status,
        'first_response_due_at', t.first_response_due_at, 'resolve_due_at', t.resolve_due_at,
        'first_response_at', s.first_response_at,
        'first_response_overdue', s.status NOT IN ('resolved','closed') AND s.first_response_at IS NULL AND t.first_response_due_at < now(),
        'resolve_overdue', s.status NOT IN ('resolved','closed') AND t.resolve_due_at < now(),
        'replies_awaiting_approval', s.replies_awaiting_approval,
        'replies_awaiting_send', s.replies_awaiting_send,
        'events', (SELECT jsonb_agg(jsonb_build_object(
          'id', e.id, 'created_at', e.created_at, 'kind', e.kind, 'status', e.status,
          'reply_event_id', e.reply_event_id, 'template_key', e.template_key,
          'body', e.body, 'actor_role', e.actor_role) ORDER BY e.created_at, e.id)
          FROM admin.support_ticket_events e WHERE e.ticket_id = t.id)
      ) AS item FROM admin.support_tickets t JOIN admin.support_ticket_state s ON s.id = t.id
      ORDER BY t.created_at DESC, t.id DESC LIMIT least(greatest(coalesce(p_limit,100),1),200)) newest), '[]'::jsonb)
  );
$function$;

-- The rate limiter rejects unregistered actions, including reads.
DO $$
DECLARE v_definition text; v_updated text;
BEGIN
  IF to_regprocedure('heroloop_api.consume_rate_limit(uuid,text)') IS NULL THEN RETURN; END IF;
  v_definition := pg_get_functiondef('heroloop_api.consume_rate_limit(uuid,text)'::regprocedure);
  v_updated := replace(v_definition, '(''player_report'',5,300),',
    '(''player_report'',5,300),(''support_ticket_submit'',3,300),(''support_ticket_list'',10,60),');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'support_ticket_rate_limit_patch_failed'; END IF;
  EXECUTE v_updated;
END
$$;
