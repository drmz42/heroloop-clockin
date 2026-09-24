\set ON_ERROR_STOP on

-- Account deletion for the Founder Control Center (Compliance / Privacy).
--
-- What HeroLoop stores about a person is the sign-in identity: the address in
-- auth.users and the wallet in heroloop_api. Everything else is keyed by an
-- opaque uuid and says nothing about who played. So deleting an account means
-- deleting that identity, and the schema's own ON DELETE CASCADE then removes
-- the account's state with it. Event rows that carry the uuid without a foreign
-- key are left standing: they are anonymous once the identity is gone, and
-- removing them would silently rewrite economy totals.
--
-- The preview is not decoration. It reads the live foreign-key graph rather
-- than a list written here, so a table added later appears in it without anyone
-- remembering to update this file, and the Founder is told exactly what will go
-- and what will stay before anything happens.

-- The deletion is a founder action of its own; it does not hide inside
-- player_operation.
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
    'analytics_export', 'account_deletion'
  ));
END
$audit_kinds$;

CREATE TABLE IF NOT EXISTS admin.account_deletions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id uuid NOT NULL,
  actor_identity_id uuid REFERENCES admin.identities(id),
  reason text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  removed jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin.account_deletions IS
  'Append-only record of account deletions: who asked, why, when, and what the preview said would be removed. The player_id stays because after the deletion it identifies nobody.';

-- Deleting a row here would erase the proof that a deletion happened.
CREATE OR REPLACE RULE account_deletions_no_delete AS ON DELETE TO admin.account_deletions DO INSTEAD NOTHING;
CREATE OR REPLACE RULE account_deletions_no_update AS ON UPDATE TO admin.account_deletions DO INSTEAD NOTHING;

CREATE OR REPLACE FUNCTION admin.account_deletion_preview(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_exists boolean;
  v_email text;
  v_username text;
  v_cascades jsonb := '[]'::jsonb;
  v_keeps jsonb := '[]'::jsonb;
  v_notes bigint := 0;
  v_rows bigint;
  v_child record;
  v_already jsonb;
BEGIN
  SELECT true, admin.mask_email(u.email) INTO v_exists, v_email
  FROM auth.users u WHERE u.id = p_player_id;
  IF NOT coalesce(v_exists, false) THEN
    SELECT to_jsonb(d) INTO v_already FROM admin.account_deletions d
    WHERE d.player_id = p_player_id ORDER BY d.created_at DESC LIMIT 1;
    RETURN jsonb_build_object('found', false, 'previous_deletion', v_already);
  END IF;

  SELECT p.username INTO v_username FROM public.players p WHERE p.player_id = p_player_id;

  -- Direct children of auth.users that the schema deletes along with it.
  FOR v_child IN
    SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass
      AND c.confdeltype = 'c' AND array_length(c.conkey, 1) = 1
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', v_child.table_name, v_child.column_name)
      INTO v_rows USING p_player_id;
    IF v_rows > 0 THEN
      v_cascades := v_cascades || jsonb_build_object('table', v_child.table_name, 'rows', v_rows);
    END IF;
  END LOOP;

  -- Tables that carry the id without a foreign key: anonymous once the identity
  -- is gone, and deliberately kept.
  FOR v_child IN
    SELECT (n.nspname || '.' || cl.relname) AS table_name
    FROM pg_class cl
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = 'player_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE cl.relkind = 'r' AND n.nspname IN ('public', 'admin')
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = cl.oid AND c.contype = 'f' AND c.confrelid = 'auth.users'::regclass
      )
    ORDER BY 1
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE player_id = $1', v_child.table_name)
      INTO v_rows USING p_player_id;
    IF v_rows > 0 THEN
      v_keeps := v_keeps || jsonb_build_object('table', v_child.table_name, 'rows', v_rows);
    END IF;
  END LOOP;

  IF to_regclass('admin.support_notes') IS NOT NULL THEN
    SELECT count(*) INTO v_notes FROM admin.support_notes WHERE player_id = p_player_id;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'player_id', p_player_id,
    'email_masked', v_email,
    'username_present', v_username IS NOT NULL,
    'support_notes', v_notes,
    'cascades', v_cascades,
    'keeps', v_keeps,
    'as_of', now()
  );
END
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

REVOKE ALL ON FUNCTION admin.account_deletion_preview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.account_delete(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.account_deletion_preview(uuid) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.account_delete(uuid, uuid, text, text) TO heroloop_admin;
GRANT SELECT ON admin.account_deletions TO heroloop_admin;

-- The Compliance screen reports that deletions happen, without reopening them.
CREATE OR REPLACE FUNCTION admin.account_deletion_summary()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'total', count(*),
    'last_30d', count(*) FILTER (WHERE created_at >= now() - interval '30 days'),
    'last_at', max(created_at)
  ) FROM admin.account_deletions;
$function$;

REVOKE ALL ON FUNCTION admin.account_deletion_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.account_deletion_summary() TO heroloop_admin;

COMMENT ON FUNCTION admin.account_delete(uuid, uuid, text, text) IS
  'Deletes the sign-in identity of one account, letting the schema cascade its state, and records what was removed. Anonymous event rows are kept on purpose. Founder-only, reason and idempotency key required, enforced by the BFF.';
