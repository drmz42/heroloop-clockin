-- Filter before the page limit, so older closed tickets remain reachable.
CREATE FUNCTION admin.support_ticket_page(p_view text, p_before_id bigint DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF p_view NOT IN ('open', 'closed', 'all') OR p_view IS NULL
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR (p_before_id IS NOT NULL AND p_before_id < 1) THEN
    RAISE EXCEPTION 'invalid_support_ticket_page';
  END IF;

  WITH selected AS MATERIALIZED (
    SELECT t.id FROM admin.support_tickets t
    JOIN admin.support_ticket_state s ON s.id = t.id
    WHERE (p_before_id IS NULL OR t.id < p_before_id)
      AND (p_view = 'all'
        OR (p_view = 'closed' AND s.status IN ('resolved', 'closed'))
        OR (p_view = 'open' AND s.status NOT IN ('resolved', 'closed')))
    ORDER BY t.id DESC LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT id FROM selected ORDER BY id DESC LIMIT p_limit
  ), items AS (
    SELECT t.id, jsonb_build_object(
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
    'tickets', coalesce((SELECT jsonb_agg(item ORDER BY id DESC) FROM items), '[]'::jsonb),
    'has_more', (SELECT count(*) > p_limit FROM selected),
    'next_before_id', (SELECT min(id) FROM page)
  ) INTO v_result;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION admin.support_ticket_page(text,bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.support_ticket_page(text,bigint,integer) TO heroloop_admin;
