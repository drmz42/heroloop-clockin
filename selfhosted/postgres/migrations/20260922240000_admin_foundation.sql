\set ON_ERROR_STOP on

-- Founder Control Center foundation (docs/game/admin-panel-proposal.md,
-- admin-access-governance-proposal.md, admin-suite-manifest.md). Repository
-- and VPS1 Staging only: no route, DNS or Nginx change; nothing is reachable
-- yet. A separate role and schema so a compromised admin service has no grant
-- on any game table (`public.*`), and the game API role has no grant here.
CREATE SCHEMA IF NOT EXISTS admin AUTHORIZATION supabase_admin;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heroloop_admin') THEN
    CREATE ROLE heroloop_admin
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heroloop_admin_runtime') THEN
    CREATE ROLE heroloop_admin_runtime
      LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

GRANT heroloop_admin TO heroloop_admin_runtime;
GRANT USAGE ON SCHEMA admin TO heroloop_admin;

-- One verified identity per row; the founder-controlled allowlist. `role` is
-- one of the three fixed roles in the admin-panel contract; custom/composite
-- roles are forbidden. `status` starts 'pending' until passkey enrollment.
CREATE TABLE admin.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text NOT NULL CHECK (role IN ('founder', 'operations_support', 'analyst')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- WebAuthn credentials. No secret ever lives here: `public_key` is a public
-- COSE key, `counter` is the signature counter (clone detection).
CREATE TABLE admin.passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES admin.identities(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  device_label text CHECK (device_label IS NULL OR char_length(device_label) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_identity_idx ON admin.passkeys(identity_id);

-- Short-lived rows only: the PKCE verifier for one in-flight Google login,
-- and one WebAuthn challenge per ceremony. Both are consumed once.
CREATE TABLE admin.oauth_pending (
  state text PRIMARY KEY,
  code_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin.passkey_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid REFERENCES admin.identities(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

-- One row per browser session. `token_hash` is sha256 of the random session
-- token; the raw token is never stored. `expires_at` is the 4-hour absolute
-- limit; idle (15 min) is checked against `last_seen_at` at request time.
-- `stepped_up_at` is the last passkey re-verify, for the 5-minute Production
-- step-up window.
CREATE TABLE admin.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES admin.identities(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  stepped_up_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX sessions_identity_idx ON admin.sessions(identity_id);

-- Append-only (enforced below by privilege, not trigger). Never a secret:
-- passwords, tokens, cookies, key material and request bodies never land
-- here; `reason` is plain text capped at 500 chars, matching admin-audit-proposal.md.
CREATE TABLE admin.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_kind text NOT NULL CHECK (event_kind IN (
    'login_identity', 'login_passkey', 'passkey_enroll', 'step_up', 'view_access', 'allowlist_change'
  )),
  actor_identity_id uuid REFERENCES admin.identities(id),
  actor_role text CHECK (actor_role IS NULL OR actor_role IN ('founder', 'operations_support', 'analyst')),
  environment text CHECK (environment IS NULL OR environment IN ('staging', 'production')),
  session_id uuid,
  request_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 500)
);
CREATE INDEX audit_log_occurred_idx ON admin.audit_log(occurred_at);

-- No RLS here: unlike the game schema (browser-facing PostgREST roles,
-- protected by SECURITY DEFINER functions owned by the table owner), this
-- schema has exactly one runtime role that queries it directly, and no
-- browser or PostgREST role ever touches it. Isolation is the schema-scoped
-- GRANT below: heroloop_admin_runtime has no grant on any public.* table,
-- and no other role has any grant here.
REVOKE ALL ON ALL TABLES IN SCHEMA admin FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin.identities, admin.passkeys, admin.oauth_pending,
  admin.passkey_challenges, admin.sessions TO heroloop_admin;
-- Audit is append-only for the runtime role: SELECT and INSERT only, never
-- UPDATE or DELETE. Only supabase_admin (not granted here) could alter it.
GRANT SELECT, INSERT ON admin.audit_log TO heroloop_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA admin TO heroloop_admin;

COMMENT ON SCHEMA admin IS
  'Founder Control Center foundation. No route is live; heroloop_admin_runtime has no grant on any public.* game table.';
