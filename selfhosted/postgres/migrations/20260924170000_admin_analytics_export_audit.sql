\set ON_ERROR_STOP on

-- The analytics export is a founder action with its own consequences - a file
-- leaves the panel - so it gets its own audit kind rather than hiding inside
-- view_access. Without this the export's audit row would be rejected by the
-- check constraint and the route would fail closed, which is the right failure
-- but not a working export.

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
    'analytics_export'
  ));
END
$audit_kinds$;
