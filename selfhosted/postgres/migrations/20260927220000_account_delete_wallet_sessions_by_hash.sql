\set ON_ERROR_STOP on

-- Follow-up to 20260927210000_account_delete_wallet_subjects.sql. Only the
-- wallet session that bound the account carries linked_account_id; later
-- sign-in and restore sessions for the same wallet do not, so a live Staging
-- check still found two sessions holding the deleted account's wallet address.
-- The account's own wallet identities name the wallet by the same hash the
-- sessions store, and a wallet belongs to one account only, so sessions are
-- now also removed by that hash.

CREATE OR REPLACE FUNCTION heroloop_api.delete_account_auth_bindings(p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api, auth
AS $function$
DECLARE
  v_subjects integer;
  v_sessions integer;
BEGIN
  -- Sessions first: the identities that name the wallet go with the account.
  DELETE FROM heroloop_api.siws_wallet_sessions
  WHERE linked_account_id = p_account_id
     OR wallet_hash IN (
       SELECT identity.subject_hash
       FROM heroloop_api.account_identities identity
       WHERE identity.account_id = p_account_id AND identity.provider = 'solana'
     );
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  DELETE FROM auth.users
  WHERE id <> p_account_id
    AND id IN (
      SELECT subject.auth_subject
      FROM heroloop_api.account_auth_subjects subject
      JOIN heroloop_api.account_identities identity USING (identity_id)
      WHERE identity.account_id = p_account_id
    );
  GET DIAGNOSTICS v_subjects = ROW_COUNT;

  RETURN jsonb_build_object('auth_subjects', v_subjects, 'wallet_sessions', v_sessions);
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.delete_account_auth_bindings(uuid) FROM PUBLIC;
