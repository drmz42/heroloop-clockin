\set ON_ERROR_STOP on

-- Global search for the Founder Control Center
-- (docs/game/founder-control-center-v2-tz.md, Platform and Governance:
-- "One input: player, task, wallet, transaction").
--
-- The search itself is a router, not a new way to read: a player, a wallet and
-- an address still go through admin.player_support_find with Player Support's
-- own exact-match, masking, role and reason rules, and a task is read from the
-- TODO snapshot the BFF already has. The one thing this file adds is the
-- fourth kind, a ledger entry, which until now had no lookup at all.
--
-- Three rules hold here. The key is matched whole: this is an equality on a
-- UNIQUE column, never a prefix, because a prefix over source keys would walk
-- the ledger one entry at a time. The metadata document is not returned, only
-- the names of its fields - a market fee carries a listing id and a promo
-- carries a code id, and neither is something the search was asked for. And
-- the player behind the entry is returned as the id alone, so the Founder can
-- open that account in Player Support, where the rules about a person live.

CREATE OR REPLACE FUNCTION admin.transaction_find(p_source_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_key text := btrim(coalesce(p_source_key, ''));
  v_entry public.hero_economy_ledger%ROWTYPE;
BEGIN
  IF char_length(v_key) < 4 OR char_length(v_key) > 160 THEN
    RAISE EXCEPTION 'invalid_transaction_key';
  END IF;
  -- Probed in its own guarded statement, like every other absent source in
  -- this schema: a database without the ledger is not a database where every
  -- transaction is missing.
  IF to_regclass('public.hero_economy_ledger') IS NULL THEN
    RETURN jsonb_build_object('state', 'not_connected');
  END IF;

  SELECT * INTO v_entry FROM public.hero_economy_ledger WHERE source_key = v_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'connected', 'found', false);
  END IF;

  RETURN jsonb_build_object(
    'state', 'connected',
    'found', true,
    'source_key', v_entry.source_key,
    'source_kind', v_entry.source_kind,
    'flow', v_entry.flow,
    'amount', v_entry.amount,
    'occurred_at', v_entry.occurred_at,
    'player_present', v_entry.player_id IS NOT NULL,
    'player_id', v_entry.player_id,
    'metadata_fields', coalesce(
      (SELECT jsonb_agg(key ORDER BY key) FROM jsonb_object_keys(coalesce(v_entry.metadata, '{}'::jsonb)) AS key),
      '[]'::jsonb)
  );
END
$function$;

REVOKE ALL ON FUNCTION admin.transaction_find(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.transaction_find(text) TO heroloop_admin;

COMMENT ON FUNCTION admin.transaction_find(text) IS
  'One ledger entry by its whole unique source key. Never a prefix, never the metadata document, and the player only as the id Player Support is opened with.';
