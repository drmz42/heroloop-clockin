#!/usr/bin/env bash
set -euo pipefail

docker_process_sql --set=api_password="$API_DATABASE_PASSWORD" <<'SQL'
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heroloop_api_runtime') THEN
    CREATE ROLE heroloop_api_runtime
      LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;

ALTER ROLE heroloop_api_runtime WITH PASSWORD :'api_password';
GRANT heroloop_api TO heroloop_api_runtime;
SQL
