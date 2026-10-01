-- Operator-only advisory checks. No browser privilege, reward or approval.
CREATE OR REPLACE FUNCTION admin.partner_quest_precheck_next()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
  SELECT jsonb_build_object(
    'id', s.id, 'submitted_at', s.submitted_at, 'proof_norm', s.proof_norm,
    'kind', q.kind, 'target_url', q.target_url, 'quest_updated_at', q.updated_at,
    'provider', CASE WHEN q.kind = 'tg_join' THEN 'telegram' ELSE 'x' END,
    'provider_user_id', l.provider_user_id, 'handle', l.handle, 'link_updated_at', l.updated_at,
    'checked_after', now())
  FROM public.partner_quest_submissions s
  JOIN public.partner_quests q ON q.id = s.quest_id
  LEFT JOIN public.player_social_links l ON l.player_id = s.player_id
    AND l.provider = CASE WHEN q.kind = 'tg_join' THEN 'telegram' ELSE 'x' END
  WHERE s.status = 'pending' AND q.status = 'active'
    AND q.starts_at <= now() AND q.ends_at > now()
    AND (s.agent_at IS NULL OR (s.agent_verdict = 'unverifiable' AND s.agent_at < now() - interval '15 minutes'))
  ORDER BY s.agent_at NULLS FIRST, s.submitted_at, s.id LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION admin.partner_quest_precheck_record(p_snapshot jsonb, p_verdict text, p_note text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, admin, public
AS $function$
DECLARE
  v_submission public.partner_quest_submissions;
  v_quest public.partner_quests;
  v_link public.player_social_links;
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('looks_ok','suspicious','unverifiable')
    OR p_note IS NULL OR char_length(p_note) NOT BETWEEN 1 AND 300
    OR p_snapshot->>'id' IS NULL OR p_snapshot->>'checked_after' IS NULL
    OR (p_snapshot->>'checked_after')::timestamptz > now() THEN
    RAISE EXCEPTION 'invalid_precheck_result' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_submission FROM public.partner_quest_submissions
    WHERE id = (p_snapshot->>'id')::bigint FOR UPDATE;
  IF NOT FOUND OR v_submission.status <> 'pending'
    OR v_submission.submitted_at IS DISTINCT FROM (p_snapshot->>'submitted_at')::timestamptz
    OR v_submission.proof_norm IS DISTINCT FROM p_snapshot->>'proof_norm'
    OR v_submission.agent_at >= (p_snapshot->>'checked_after')::timestamptz THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'stale_submission');
  END IF;
  SELECT * INTO v_quest FROM public.partner_quests WHERE id = v_submission.quest_id FOR SHARE;
  IF v_quest.status <> 'active' OR v_quest.starts_at > now() OR v_quest.ends_at <= now()
    OR v_quest.updated_at IS DISTINCT FROM (p_snapshot->>'quest_updated_at')::timestamptz THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'stale_quest');
  END IF;
  SELECT * INTO v_link FROM public.player_social_links
    WHERE player_id = v_submission.player_id AND provider = p_snapshot->>'provider' FOR SHARE;
  IF v_link.provider_user_id IS DISTINCT FROM p_snapshot->>'provider_user_id'
    OR v_link.updated_at IS DISTINCT FROM (p_snapshot->>'link_updated_at')::timestamptz THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'stale_link');
  END IF;
  PERFORM admin.partner_quest_agent_record(v_submission.id, p_verdict, p_note);
  RETURN jsonb_build_object('recorded', true);
END
$function$;
REVOKE ALL ON FUNCTION admin.partner_quest_precheck_next() FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.partner_quest_precheck_record(jsonb,text,text) FROM PUBLIC;
