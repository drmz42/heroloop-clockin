\set ON_ERROR_STOP on

-- Compliance read model for the Founder Control Center
-- (docs/game/founder-control-center-v2-tz.md, Platform and Governance).
--
-- Counts only: how many accounts are waiting on deletion or locked for
-- recovery, and how long the oldest one has been waiting. It returns no account
-- id, email or wallet, because knowing that a queue exists is a different
-- question from looking at the person in it — that stays on Player Support.
--
-- This function only reports. Deleting or exporting a player's data is a
-- mutation with its own contract, Founder approval and step-up, and nothing
-- here can perform or approve one.

CREATE OR REPLACE FUNCTION admin.compliance_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now timestamptz := now();
  v_accounts jsonb := jsonb_build_object('state', 'not_connected');
  v_players jsonb;
BEGIN
  -- Guarded in its own statement: a reference to a missing relation is rejected
  -- when the statement is first parsed, whatever branch it sits in.
  IF to_regclass('heroloop_api.heroloop_accounts') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'state', 'connected',
      'total', count(*),
      'active', count(*) FILTER (WHERE state = 'active'),
      'recovery_locked', count(*) FILTER (WHERE state = 'recovery_locked'),
      'deletion_pending', count(*) FILTER (WHERE state = 'deletion_pending'),
      'oldest_deletion_pending_at', min(updated_at) FILTER (WHERE state = 'deletion_pending'),
      'deletion_pending_over_30d', count(*) FILTER (
        WHERE state = 'deletion_pending' AND updated_at < v_now - interval '30 days'
      )
    ) INTO v_accounts
    FROM heroloop_api.heroloop_accounts;
  END IF;

  -- How much player-scoped data the request queue would have to reach. Table
  -- counts, not rows of anyone's data.
  SELECT jsonb_build_object(
    'players', (SELECT count(*) FROM public.players),
    'saves', CASE WHEN to_regclass('public.player_saves') IS NULL THEN NULL
                  ELSE (SELECT count(*) FROM public.player_saves) END
  ) INTO v_players;

  RETURN jsonb_build_object(
    'version', 'compliance.v1',
    'as_of', v_now,
    'timezone', 'UTC',
    'accounts', v_accounts,
    'scope', v_players,
    -- No table records a player's request to be deleted or to receive an
    -- export, so the queue is not connected rather than empty: an empty queue
    -- would claim nobody has asked.
    'deletion_requests', 'not_connected',
    'export_requests', 'not_connected'
  );
END
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand this to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.compliance_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.compliance_summary() TO heroloop_admin;

COMMENT ON FUNCTION admin.compliance_summary() IS
  'Aggregate-only Compliance read for the Founder Control Center: account lifecycle states and the size of player-scoped data, with request queues reported as not connected; never an account id, never a write.';
