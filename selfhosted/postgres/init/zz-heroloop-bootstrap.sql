\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'heroloop_migrator',
    'heroloop_api',
    'heroloop_worker',
    'heroloop_backup',
    'heroloop_restore_verifier'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT',
        role_name
      );
    END IF;
  END LOOP;
END
$roles$;

DO $backup_runtime$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heroloop_backup_runtime') THEN
    CREATE ROLE heroloop_backup_runtime
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS NOINHERIT;
  ELSE
    ALTER ROLE heroloop_backup_runtime
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$backup_runtime$;

CREATE SCHEMA IF NOT EXISTS heroloop_migrations AUTHORIZATION supabase_admin;

CREATE TABLE IF NOT EXISTS heroloop_migrations.applied_migrations (
  version text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON SCHEMA heroloop_migrations FROM PUBLIC;
REVOKE ALL ON TABLE heroloop_migrations.applied_migrations FROM PUBLIC;
GRANT USAGE ON SCHEMA heroloop_migrations TO heroloop_migrator, heroloop_backup, heroloop_restore_verifier;
GRANT SELECT, INSERT ON TABLE heroloop_migrations.applied_migrations TO heroloop_migrator;
GRANT SELECT ON TABLE heroloop_migrations.applied_migrations TO heroloop_backup, heroloop_restore_verifier;
