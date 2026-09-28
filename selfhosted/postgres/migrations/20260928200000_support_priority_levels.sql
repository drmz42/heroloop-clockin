-- Five named support priorities. Numeric levels stay server-side; critical is
-- first in the open queue, with the existing urgent SLA as its deadline.
ALTER TABLE admin.support_tickets DROP CONSTRAINT support_tickets_game_origin;
ALTER TABLE admin.support_tickets ADD CONSTRAINT support_tickets_game_origin CHECK (
  (channel = 'game' AND created_by IS NULL AND player_id IS NOT NULL AND topic IS NOT NULL AND player_priority IS NOT NULL)
  OR (channel <> 'game' AND created_by IS NOT NULL AND topic IS NULL)
);

CREATE FUNCTION admin.support_ticket_open(
  p_actor uuid, p_channel text, p_player_id uuid, p_subject text, p_summary text, p_priority integer, p_idempotency_key uuid
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
  v_priority text;
  v_id bigint;
BEGIN
  v_role := admin.support_ticket_actor(p_actor);
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('telegram', 'discord', 'email', 'x', 'other') THEN
    RAISE EXCEPTION 'invalid_ticket_channel' USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NULL OR p_priority NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'invalid_ticket_priority' USING ERRCODE = '22023';
  END IF;
  v_priority := CASE WHEN p_priority >= 4 THEN 'urgent' WHEN p_priority = 3 THEN 'high'
    WHEN p_priority = 2 THEN 'normal' ELSE 'low' END;
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
    IF v_existing.subject <> v_subject OR v_existing.channel <> p_channel OR v_existing.priority <> v_priority OR v_existing.player_priority IS DISTINCT FROM p_priority
       OR v_existing.player_id IS DISTINCT FROM p_player_id THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_existing.id, 'replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM admin.support_ticket_events WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
  END IF;

  v_sla := admin.support_ticket_sla(v_priority);
  INSERT INTO admin.support_tickets(created_by, channel, player_id, subject, player_priority, priority, first_response_due_at, resolve_due_at, idempotency_key)
  VALUES (p_actor, p_channel, p_player_id, v_subject, p_priority, v_priority,
          now() + make_interval(hours => (v_sla->>'first_response_hours')::integer),
          now() + make_interval(hours => (v_sla->>'resolve_hours')::integer),
          p_idempotency_key)
  RETURNING id INTO v_id;
  INSERT INTO admin.support_ticket_events(ticket_id, actor_identity_id, actor_role, kind, body, idempotency_key)
  VALUES (v_id, p_actor, v_role, 'opened', v_summary, gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'replayed', false);
END
$function$;

REVOKE ALL ON FUNCTION admin.support_ticket_open(uuid,text,uuid,text,text,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.support_ticket_open(uuid,text,uuid,text,text,integer,uuid) TO heroloop_admin;

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
  IF p_priority IS NULL OR p_priority NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'invalid_support_priority'; END IF;
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

CREATE OR REPLACE FUNCTION admin.support_ticket_page(p_view text, p_before_id bigint DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE v_result jsonb; v_before_rank integer;
BEGIN
  IF p_view NOT IN ('open', 'closed', 'all') OR p_view IS NULL
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR (p_before_id IS NOT NULL AND p_before_id < 1) THEN
    RAISE EXCEPTION 'invalid_support_ticket_page';
  END IF;

  IF p_view = 'open' AND p_before_id IS NOT NULL THEN
    SELECT coalesce(player_priority, CASE priority
      WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END)
    INTO v_before_rank FROM admin.support_tickets WHERE id = p_before_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_support_ticket_page'; END IF;
  END IF;

  WITH ranked AS (
    SELECT t.id, coalesce(t.player_priority, CASE t.priority
      WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 ELSE 1 END) AS priority_rank
    FROM admin.support_tickets t JOIN admin.support_ticket_state s ON s.id = t.id
    WHERE (p_view = 'all'
      OR (p_view = 'closed' AND s.status IN ('resolved', 'closed'))
      OR (p_view = 'open' AND s.status NOT IN ('resolved', 'closed')))
  ), selected AS MATERIALIZED (
    SELECT id, priority_rank FROM ranked
    WHERE (p_view = 'open' AND (p_before_id IS NULL OR priority_rank < v_before_rank
      OR (priority_rank = v_before_rank AND id < p_before_id)))
      OR (p_view <> 'open' AND (p_before_id IS NULL OR id < p_before_id))
    ORDER BY CASE WHEN p_view = 'open' THEN priority_rank END DESC, id DESC
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT id, priority_rank FROM selected
    ORDER BY CASE WHEN p_view = 'open' THEN priority_rank END DESC, id DESC LIMIT p_limit
  ), items AS (
    SELECT t.id, page.priority_rank, jsonb_build_object(
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
    ) AS item
    FROM page JOIN admin.support_tickets t USING (id)
    JOIN admin.support_ticket_state s ON s.id = t.id
  )
  SELECT jsonb_build_object(
    'as_of', now(), 'counts', admin.support_ticket_counts(),
    'tickets', coalesce((SELECT jsonb_agg(item ORDER BY CASE WHEN p_view = 'open' THEN priority_rank END DESC, id DESC) FROM items), '[]'::jsonb),
    'has_more', (SELECT count(*) > p_limit FROM selected),
    'next_before_id', (SELECT id FROM page ORDER BY CASE WHEN p_view = 'open' THEN priority_rank END ASC, id ASC LIMIT 1)
  ) INTO v_result;
  RETURN v_result;
END
$function$;
