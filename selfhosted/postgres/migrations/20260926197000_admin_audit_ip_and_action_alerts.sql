\set ON_ERROR_STOP on

-- Two requirements of the separate admin panel (HL-TASK-80D35E8A4930,
-- docs/game/admin-panel-proposal.md) the Control Center did not meet yet:
--
-- 1. Audit rows carry the client address. The BFF listens on loopback only
--    behind Nginx, which appends the real peer to X-Forwarded-For; the BFF
--    stores that last entry. It is staff metadata for incident review, never a
--    player's address.
-- 2. Exports, role and access changes, economy actions and player mutations
--    reach the Founder's phone. admin.notification_audit_scan() turns each new
--    successful audit row of those kinds into one warning, which the existing
--    5-minute dispatcher delivers. A hijacked founder session doing any of them
--    is then seen within minutes, not at the next look at the audit screen.
--    The message names the action and the role only: no reason text, no
--    player, no address. It starts from the rows written after this migration,
--    so installing it does not replay history.

ALTER TABLE admin.audit_log ADD COLUMN IF NOT EXISTS client_ip inet;

CREATE TABLE IF NOT EXISTS admin.notification_audit_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_audit_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin.notification_audit_cursor(last_audit_id)
SELECT coalesce(max(id), 0) FROM admin.audit_log
ON CONFLICT (singleton) DO NOTHING;
REVOKE ALL ON admin.notification_audit_cursor FROM PUBLIC;

COMMENT ON TABLE admin.notification_audit_cursor IS
  'The last admin.audit_log id the action-alert scan has looked at; one row, moved only by admin.notification_audit_scan.';

CREATE OR REPLACE FUNCTION admin.notification_audit_label(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE p_kind
    WHEN 'analytics_export' THEN 'data export'
    WHEN 'allowlist_change' THEN 'panel access change'
    WHEN 'account_deletion' THEN 'account deletion'
    WHEN 'player_operation' THEN 'player change'
    WHEN 'player_unmask' THEN 'player data unmask'
    WHEN 'feature_flag_change' THEN 'flag toggle'
    WHEN 'ledger_baseline' THEN 'new $HERO reconciliation baseline'
    WHEN 'finance_record' THEN 'finance record'
  END
$function$;

CREATE OR REPLACE FUNCTION admin.notification_audit_scan(p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_cursor bigint;
  v_last bigint;
  v_row record;
  v_recorded integer := 0;
  v_skipped bigint := 0;
BEGIN
  SELECT last_audit_id INTO v_cursor FROM admin.notification_audit_cursor WHERE singleton FOR UPDATE;
  IF v_cursor IS NULL THEN
    INSERT INTO admin.notification_audit_cursor(last_audit_id) SELECT coalesce(max(id), 0) FROM admin.audit_log;
    RETURN jsonb_build_object('recorded', 0, 'started', true);
  END IF;
  v_last := v_cursor;

  FOR v_row IN
    SELECT id, event_kind, actor_role, environment
    FROM admin.audit_log
    WHERE id > v_cursor AND outcome = 'success' AND admin.notification_audit_label(event_kind) IS NOT NULL
    ORDER BY id
    LIMIT v_limit
  LOOP
    PERFORM admin.notification_record('alerts', 'warning', 'audit:' || v_row.id,
      'Panel action: ' || admin.notification_audit_label(v_row.event_kind),
      format('Role %s, environment %s. Details: Security > panel log. If this was not you, end other sessions there.',
        coalesce(v_row.actor_role, 'none'), coalesce(v_row.environment, 'none')),
      1);
    v_recorded := v_recorded + 1;
    v_last := v_row.id;
  END LOOP;

  -- More than one pass can carry: the rest are summarised once and skipped, so
  -- a burst cannot flood the phone or stall the cursor.
  IF v_recorded = v_limit THEN
    SELECT count(*), coalesce(max(id), v_last) INTO v_skipped, v_last
    FROM admin.audit_log
    WHERE id > v_last AND outcome = 'success' AND admin.notification_audit_label(event_kind) IS NOT NULL;
    IF v_skipped > 0 THEN
      PERFORM admin.notification_record('alerts', 'warning', 'audit:burst',
        'Many panel actions in a row',
        format('%s more actions beyond %s in one pass. Check the panel log under Security.', v_skipped, v_limit),
        1);
    END IF;
  END IF;

  -- Rows of other kinds are passed over too, so the cursor always reaches the
  -- newest id the scan could see.
  SELECT greatest(v_last, CASE WHEN v_recorded < v_limit THEN coalesce(max(id), v_last) ELSE v_last END)
    INTO v_last FROM admin.audit_log;
  UPDATE admin.notification_audit_cursor SET last_audit_id = v_last, updated_at = now() WHERE singleton;
  RETURN jsonb_build_object('recorded', v_recorded, 'summarised', v_skipped, 'cursor', v_last);
END
$function$;

REVOKE ALL ON FUNCTION admin.notification_audit_label(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.notification_audit_scan(integer) FROM PUBLIC;

COMMENT ON FUNCTION admin.notification_audit_scan(integer) IS
  'Turns each new successful export, access, economy or player-mutation audit row into one warning for the Founder (action and role only); run by the notification dispatcher, not granted to the panel.';
