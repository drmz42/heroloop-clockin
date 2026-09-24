\set ON_ERROR_STOP on

-- Support and risk queue for the Founder Control Center Overview
-- (docs/game/founder-control-center-v2-tz.md, "Risk/support/incidents queue").
--
-- Counts only: how many accounts sit at each risk level, how many reviews are
-- past their deadline, and how much support work happened recently. It never
-- returns a player id, a note body or a reason, so the Overview queue cannot
-- become a way to read one account's history; that stays on Player Support
-- behind its own role, reason and step-up rules.
--
-- Incidents and pending approvals have no table in this database, so they are
-- reported as untracked rather than as an empty queue that looks healthy.

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
BEGIN
  -- Every level the constraint allows is reported, including the ones with no
  -- accounts: a missing key in the object would read as "no such level" rather
  -- than "nobody is there".
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
    'incidents', 'not_tracked',
    'approvals', 'not_tracked'
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.support_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.support_queue() TO heroloop_admin;

COMMENT ON FUNCTION admin.support_queue() IS
  'Aggregate-only support and risk queue for the Founder Control Center Overview: counts and deadlines, never a player id, note or reason.';
