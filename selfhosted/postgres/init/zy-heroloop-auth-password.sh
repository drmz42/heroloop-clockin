#!/usr/bin/env bash
set -euo pipefail

psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 --set=auth_password="$POSTGRES_PASSWORD" <<'SQL'
ALTER ROLE supabase_auth_admin WITH PASSWORD :'auth_password';
SQL
