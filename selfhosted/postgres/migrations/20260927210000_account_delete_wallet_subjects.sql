\set ON_ERROR_STOP on

-- Deleting an account left the wallet behind. A wallet sign-in creates its own
-- GoTrue (Web3) user whose auth.identities row holds the wallet address, bound
-- to the account through heroloop_api.account_auth_subjects. Both deletion
-- paths removed only the auth user whose id is the account id, so for an
-- account that was created as a guest and then linked a wallet, the Web3 user
-- (and with it the address) survived, and its wallet sessions kept the address
-- until their 24-hour purge. Both paths now remove every Auth subject bound to
-- the account's identities and every wallet session linked to it first.

CREATE OR REPLACE FUNCTION heroloop_api.delete_account_auth_bindings(p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api, auth
AS $function$
DECLARE
  v_subjects integer;
  v_sessions integer;
BEGIN
  -- The subjects are collected before any delete: removing the account's own
  -- auth user cascades away the identities that lead to them.
  DELETE FROM auth.users
  WHERE id <> p_account_id
    AND id IN (
      SELECT subject.auth_subject
      FROM heroloop_api.account_auth_subjects subject
      JOIN heroloop_api.account_identities identity USING (identity_id)
      WHERE identity.account_id = p_account_id
    );
  GET DIAGNOSTICS v_subjects = ROW_COUNT;

  DELETE FROM heroloop_api.siws_wallet_sessions WHERE linked_account_id = p_account_id;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  RETURN jsonb_build_object('auth_subjects', v_subjects, 'wallet_sessions', v_sessions);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.delete_account_auth_bindings(uuid) FROM PUBLIC;
COMMENT ON FUNCTION heroloop_api.delete_account_auth_bindings(uuid) IS
  'Removes the wallet Auth subjects and wallet sessions bound to one account; called only inside the two account deletion functions.';

-- Player self-deletion from the game.
CREATE OR REPLACE FUNCTION heroloop_api.account_delete(p_player_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $function$
DECLARE
  v_deleted uuid;
BEGIN
  PERFORM 1 FROM auth.users WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'api_auth_user_missing'; END IF;

  PERFORM heroloop_api.delete_account_auth_bindings(p_player_id);

  DELETE FROM auth.users
  WHERE id = p_player_id
  RETURNING id INTO v_deleted;

  DELETE FROM public.players WHERE player_id = p_player_id;
  RETURN jsonb_build_object('deleted', true, 'account_id', v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.account_delete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION heroloop_api.account_delete(uuid) TO heroloop_api;

-- Founder deletion from the Control Center: same fix, patched into the current
-- definition so its reason, idempotency and evidence-hold rules stay as they are.
DO $$
DECLARE
  v_definition text;
  v_updated text;
BEGIN
  v_definition := pg_get_functiondef('admin.account_delete(uuid,uuid,text,text)'::regprocedure);
  IF position('delete_account_auth_bindings' IN v_definition) > 0 THEN RETURN; END IF;
  v_updated := replace(v_definition,
    '  DELETE FROM auth.users WHERE id = p_player_id;',
    E'  PERFORM heroloop_api.delete_account_auth_bindings(p_player_id);\n  DELETE FROM auth.users WHERE id = p_player_id;');
  IF v_updated = v_definition THEN RAISE EXCEPTION 'admin_account_delete_patch_failed'; END IF;
  EXECUTE v_updated;
END
$$;
