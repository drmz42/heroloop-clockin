\set ON_ERROR_STOP on

-- An account under Review or Hold cannot be deleted from the Control Center
-- (docs/game/storage-and-retention-policy.md: "Deleting or unlinking an account
-- under Hold is refused or keeps the evidence"). Deletion cascades the account's
-- state away, and a case whose evidence is gone cannot be decided, so the
-- deletion is refused while the case is open. Review is included because it is
-- the same open case one step earlier. Watch is only a note and does not block.
-- The Founder can still delete: lower the level on the existing risk route
-- (which records who, when and why), then delete.
--
-- The player's own deletion (heroloop_api.account_delete) is not changed here;
-- whether a player may delete an account under Review/Hold is a Founder
-- decision recorded on HL-TASK-20260921203753-0BB316.

CREATE OR REPLACE FUNCTION admin.account_evidence_hold(p_player_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT r.level FROM public.account_risk_levels r
  WHERE r.player_id = p_player_id AND r.level IN ('review', 'hold')
$function$;

CREATE OR REPLACE FUNCTION admin.account_delete(
  p_player_id uuid,
  p_actor_identity_id uuid,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing admin.account_deletions;
  v_preview jsonb;
  v_record admin.account_deletions;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;

  -- A repeated call with the same key returns what the first one did instead of
  -- reporting that the account is already gone.
  SELECT * INTO v_existing FROM admin.account_deletions WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.player_id <> p_player_id THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('deleted', false, 'replayed', true, 'record', to_jsonb(v_existing));
  END IF;

  -- The risk row is locked so a level change cannot slip between this check
  -- and the delete below.
  PERFORM 1 FROM public.account_risk_levels
  WHERE player_id = p_player_id AND level IN ('review', 'hold')
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'account_under_evidence_hold' USING ERRCODE = '22023';
  END IF;

  v_preview := admin.account_deletion_preview(p_player_id);
  IF NOT (v_preview ->> 'found')::boolean THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO admin.account_deletions(player_id, actor_identity_id, reason, idempotency_key, removed)
  VALUES (p_player_id, p_actor_identity_id, btrim(p_reason), p_idempotency_key, v_preview)
  RETURNING * INTO v_record;

  -- Staff free text can name a person even when the schema does not.
  IF to_regclass('admin.support_notes') IS NOT NULL THEN
    DELETE FROM admin.support_notes WHERE player_id = p_player_id;
  END IF;

  -- One statement: the identity. Everything the schema marked ON DELETE CASCADE
  -- goes with it, which is what the preview listed.
  DELETE FROM auth.users WHERE id = p_player_id;

  RETURN jsonb_build_object('deleted', true, 'replayed', false, 'record', to_jsonb(v_record));
END
$function$;

REVOKE ALL ON FUNCTION admin.account_evidence_hold(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.account_delete(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.account_evidence_hold(uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.account_delete(uuid, uuid, text, text) TO heroloop_admin;

COMMENT ON FUNCTION admin.account_evidence_hold(uuid) IS
  'The account''s open risk case level (review or hold) that blocks deletion, or NULL when deletion is not held.';
