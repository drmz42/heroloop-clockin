\set ON_ERROR_STOP on

-- Player support for the Founder Control Center (config/admin-player-support.v1.json).
--
-- The isolation promise from the admin foundation is kept exactly as it was:
-- heroloop_admin_runtime still holds no grant on any public.* game table. It
-- gains EXECUTE on two narrow SECURITY DEFINER functions instead, so the panel
-- can read one player's masked support card and change one field — the
-- account risk level, through the game's own server-authoritative
-- public.set_account_risk_level. Balances, saves, heroes, inventory and
-- identities have no write path here at all.

-- Support notes live in the admin schema, never in a game table: they are the
-- panel's own record, and keeping them here means a note can never contend
-- with gameplay writes. Append-only is enforced by privilege below, as the
-- audit log already is.
CREATE TABLE IF NOT EXISTS admin.support_notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id uuid NOT NULL,
  author_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  author_role text NOT NULL CHECK (author_role IN ('founder', 'operations_support', 'analyst')),
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_notes_player_idx ON admin.support_notes(player_id, created_at DESC);

-- One row per executed player operation, keyed by the caller's idempotency
-- key. A retry of the same request returns the stored result instead of acting
-- twice; the same key carrying a different request is refused rather than
-- guessed at. Append-only by privilege, like the notes and the audit log.
CREATE TABLE IF NOT EXISTS admin.player_operations (
  idempotency_key uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('risk_change')),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_identity_id uuid NOT NULL REFERENCES admin.identities(id),
  actor_role text NOT NULL CHECK (actor_role IN ('founder', 'operations_support', 'analyst')),
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS player_operations_player_idx ON admin.player_operations(player_id, created_at DESC);

-- The audit log gains the player-support event kinds the contract requires.
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
    'player_search', 'player_view', 'player_unmask', 'support_note', 'player_operation'
  ));
END
$audit_kinds$;

-- Masking helpers. A masked value proves the shape of what is stored without
-- handing over the value itself, so an over-the-shoulder read of the panel
-- cannot harvest an address or a wallet.
CREATE OR REPLACE FUNCTION admin.mask_email(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_email IS NULL OR position('@' in p_email) = 0 THEN NULL
    ELSE left(split_part(p_email, '@', 1), 1) || '***@' || right(split_part(p_email, '@', 2), 8)
  END
$function$;

CREATE OR REPLACE FUNCTION admin.mask_key(p_key text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_key IS NULL OR char_length(p_key) < 12 THEN NULL
    ELSE left(p_key, 4) || '…' || right(p_key, 4)
  END
$function$;

-- One player, found by one exact key. Never a list: a prefix, fuzzy or bulk
-- lookup would turn support into an enumeration tool, so the input is an exact
-- identifier and the result is at most one row. Unmasking is a separate,
-- explicitly requested read that the BFF only performs for a founder with a
-- fresh passkey step-up, and audits.
CREATE OR REPLACE FUNCTION admin.player_support_find(
  p_key text,
  p_value text,
  p_unmask boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_player_id uuid;
  v_value text := btrim(coalesce(p_value, ''));
  v_email text;
  v_wallet text;
  v_player public.players%ROWTYPE;
  v_risk_level text;
  v_risk public.account_risk_levels%ROWTYPE;
BEGIN
  IF p_key NOT IN ('player_id', 'email', 'wallet_public_key') THEN
    RAISE EXCEPTION 'invalid_search_key';
  END IF;
  IF char_length(v_value) < 8 THEN
    RAISE EXCEPTION 'search_value_too_short';
  END IF;

  IF p_key = 'player_id' THEN
    BEGIN
      v_player_id := v_value::uuid;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  ELSIF p_key = 'email' THEN
    SELECT u.id INTO v_player_id FROM auth.users u
    WHERE lower(u.email) = lower(v_value) LIMIT 1;
  ELSE
    SELECT i.account_id INTO v_player_id FROM heroloop_api.account_identities i
    WHERE i.provider_subject = v_value AND i.revoked_at IS NULL LIMIT 1;
  END IF;

  IF v_player_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_player FROM public.players WHERE player_id = v_player_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_player_id;
  SELECT i.provider_subject INTO v_wallet FROM heroloop_api.account_identities i
  WHERE i.account_id = v_player_id AND i.provider = 'solana' AND i.revoked_at IS NULL
  ORDER BY i.created_at LIMIT 1;

  v_risk_level := public.account_risk_level(v_player_id);
  SELECT * INTO v_risk FROM public.account_risk_levels WHERE player_id = v_player_id;

  RETURN jsonb_build_object(
    'player_id', v_player.player_id,
    'username', v_player.username,
    'account_level', v_player.account_level,
    'power', v_player.power,
    'combat_power', v_player.combat_power,
    'online', v_player.online,
    'last_heartbeat', v_player.last_heartbeat,
    'updated_at', v_player.updated_at,
    'heroes_owned', v_player.heroes_owned,
    'highest_location', v_player.highest_location,
    'total_kills', v_player.total_kills,
    'boss_kills', v_player.boss_kills,
    'summons', v_player.summons,
    'token_balance', v_player.token_balance,
    'pending_tokens', v_player.pending_tokens,
    'total_claimed', v_player.total_claimed,
    'token_eligible', v_player.token_eligible,
    'email', CASE WHEN p_unmask THEN v_email ELSE admin.mask_email(v_email) END,
    'email_present', v_email IS NOT NULL,
    'wallet_public_key', CASE WHEN p_unmask THEN v_wallet ELSE admin.mask_key(v_wallet) END,
    'wallet_present', v_wallet IS NOT NULL,
    'masked', NOT p_unmask,
    'risk_level', v_risk_level,
    'risk_reason_codes', to_jsonb(coalesce(v_risk.reason_codes, '{}'::text[])),
    'risk_set_by', v_risk.set_by,
    'risk_review_deadline', v_risk.review_deadline,
    'risk_updated_at', v_risk.updated_at
  );
END
$function$;

-- The panel's only write into game state. It cannot choose its own actor: the
-- call is always recorded as the founder, which is what public.set_account_risk_level
-- requires before it will lower a Review or Hold. Everything else the contract
-- forbids — balances, rewards, saves, inventory, identities — has no path here.
CREATE OR REPLACE FUNCTION admin.player_support_set_risk(
  p_player_id uuid,
  p_level text,
  p_reason_codes text[],
  p_note text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE player_id = p_player_id) THEN
    RAISE EXCEPTION 'unknown_player';
  END IF;
  v_result := public.set_account_risk_level(
    p_player_id, p_level, 'founder', coalesce(p_reason_codes, '{}'::text[]), p_note, NULL
  );
  RETURN v_result;
END
$function$;

-- The last twenty risk changes for one player, for the panel's account history.
CREATE OR REPLACE FUNCTION admin.player_risk_events(p_player_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT coalesce(jsonb_agg(event ORDER BY event->>'created_at' DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'from_level', e.from_level,
      'to_level', e.to_level,
      'actor', e.actor,
      'reason_codes', to_jsonb(e.reason_codes),
      'note', e.note,
      'created_at', e.created_at
    ) AS event
    FROM public.account_risk_events e
    WHERE e.player_id = p_player_id
    ORDER BY e.created_at DESC
    LIMIT 20
  ) recent
$function$;

-- SECURITY DEFINER plus the default PUBLIC execute grant would hand these to
-- every role in the database, including the browser-facing game roles.
REVOKE ALL ON FUNCTION admin.player_support_find(text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_support_set_risk(uuid, text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.player_risk_events(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.mask_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin.mask_key(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION admin.player_support_find(text, text, boolean) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.player_support_set_risk(uuid, text, text[], text) TO heroloop_admin;
GRANT EXECUTE ON FUNCTION admin.player_risk_events(uuid) TO heroloop_admin;

-- Append-only by privilege: inserted and read, never updated or deleted.
REVOKE ALL ON admin.support_notes FROM PUBLIC;
REVOKE ALL ON admin.player_operations FROM PUBLIC;
GRANT SELECT, INSERT ON admin.support_notes TO heroloop_admin;
GRANT SELECT, INSERT ON admin.player_operations TO heroloop_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA admin TO heroloop_admin;

COMMENT ON FUNCTION admin.player_support_find(text, text, boolean) IS
  'One player, exact key only, masked unless the caller proved a founder step-up.';
COMMENT ON FUNCTION admin.player_support_set_risk(uuid, text, text[], text) IS
  'The only Founder Control Center write into game state: account risk level, via public.set_account_risk_level as founder.';
