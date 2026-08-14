#!/usr/bin/env bash
set -euo pipefail

docker_process_sql --set=auth_password="$POSTGRES_PASSWORD" <<'SQL'
ALTER ROLE supabase_auth_admin WITH PASSWORD :'auth_password';
SQL
