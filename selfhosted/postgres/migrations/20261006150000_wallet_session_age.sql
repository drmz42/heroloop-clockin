-- Wallet sign-ins last as long as the offline-earnings window: 8 hours, or
-- 24 hours while Boost Max is active. The client enforced this alone, so a
-- refreshed GoTrue wallet session kept authenticating API commands for days.
-- The API now resolves the caller with its GoTrue session id; a Web3 (wallet)
-- Auth subject is accepted only for a session of its own that is younger than
-- the limit derived from the server Boost Max state.
BEGIN;

CREATE OR REPLACE FUNCTION heroloop_api.resolve_authenticated_account_session(
  p_auth_subject uuid,
  p_session uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, heroloop_api, auth
AS $function$
DECLARE
  v_result jsonb := heroloop_api.resolve_authenticated_account(p_auth_subject);
  v_created timestamptz;
  v_boost boolean;
BEGIN
  IF v_result->>'authenticated' IS DISTINCT FROM 'true' THEN
    RETURN v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.identities
    WHERE user_id = p_auth_subject AND provider = 'web3') THEN
    RETURN v_result;
  END IF;
  SELECT created_at INTO v_created FROM auth.sessions
  WHERE id = p_session AND user_id = p_auth_subject;
  IF v_created IS NULL THEN
    RETURN jsonb_build_object('authenticated', false, 'reason', 'wallet_session_unknown');
  END IF;
  SELECT boost_max_active INTO v_boost FROM public.players
  WHERE player_id = (v_result->>'account_id')::uuid;
  IF clock_timestamp() - v_created >=
    (CASE WHEN v_boost IS TRUE THEN interval '24 hours' ELSE interval '8 hours' END) THEN
    RETURN jsonb_build_object('authenticated', false, 'reason', 'wallet_session_expired');
  END IF;
  RETURN v_result;
END
$function$;

REVOKE ALL ON FUNCTION heroloop_api.resolve_authenticated_account_session(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION heroloop_api.resolve_authenticated_account_session(uuid, uuid) TO heroloop_api;
COMMENT ON FUNCTION heroloop_api.resolve_authenticated_account_session(uuid, uuid) IS
  'Resolves an API caller like resolve_authenticated_account and limits wallet sessions to 8 hours, or 24 hours with Boost Max.';

COMMIT;
