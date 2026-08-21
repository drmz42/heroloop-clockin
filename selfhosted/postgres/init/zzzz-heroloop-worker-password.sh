#!/usr/bin/env bash
set -euo pipefail

docker_process_sql --set=worker_password="$WORKER_DATABASE_PASSWORD" <<'SQL'
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'heroloop_worker_runtime') THEN
    CREATE ROLE heroloop_worker_runtime
      LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;

ALTER ROLE heroloop_worker_runtime WITH PASSWORD :'worker_password';
GRANT heroloop_worker TO heroloop_worker_runtime;
SQL
