#!/usr/bin/env bash
set -euo pipefail

container=${1:?usage: apply-selfhosted-baseline.sh <postgres-container-id>}
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
manifest=$repo/selfhosted/postgres/baseline-satisfied.tsv
docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo -n docker); fi

[[ $container =~ ^[a-f0-9]{12,64}$ ]] || { echo 'invalid PostgreSQL container id' >&2; exit 1; }
[[ -s $manifest ]] || { echo 'baseline satisfied manifest is missing' >&2; exit 1; }

psql_command() {
  "${docker_cmd[@]}" exec "$container" psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 "$@"
}

psql_file() {
  local file=$1
  "${docker_cmd[@]}" exec -i "$container" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 <"$file"
}

psql_command -q -c '
  CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(
    version text PRIMARY KEY,
    statements text[],
    name text
  );
' >/dev/null

declare -A manifest_hash manifest_condition manifest_seen
while IFS=$'\t' read -r filename checksum condition extra; do
  [[ -z ${filename// } || $filename == \#* ]] && continue
  [[ -z $extra && $filename =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ && $checksum =~ ^[a-f0-9]{64}$ && $condition =~ ^[a-z0-9_]+$ ]] || {
    echo "invalid baseline manifest row: $filename" >&2
    exit 1
  }
  [[ -z ${manifest_hash[$filename]+x} ]] || { echo "duplicate baseline manifest row: $filename" >&2; exit 1; }
  manifest_hash[$filename]=$checksum
  manifest_condition[$filename]=$condition
done <"$manifest"

record_checksum() {
  local version=$1 checksum=$2 existing
  existing=$(psql_command -Atq -c "SELECT checksum_sha256 FROM heroloop_migrations.applied_migrations WHERE version='$version'")
  [[ -z $existing || $existing == "$checksum" ]] || { echo "migration checksum mismatch in ledger: $version" >&2; exit 1; }
  if [[ -z $existing ]]; then
    psql_command -q -c "INSERT INTO heroloop_migrations.applied_migrations(version,checksum_sha256) VALUES ('$version','$checksum')" >/dev/null
  fi
}

verify_satisfied_postcondition() {
  local condition=$1 query
  case $condition in
    dungeon_room_progress_v2)
      query="SELECT position('v_encounter.room_state->>''kind''=''retinue''' IN pg_get_functiondef('public.dungeon_room_complete(uuid,uuid,bigint,uuid)'::regprocedure)) > 0"
      ;;
    dungeon_identity_cast_min_one)
      query="SELECT position('v_identity_casts:=GREATEST(1,FLOOR' IN pg_get_functiondef('public.dungeon_shared_boss_action(uuid,uuid,bigint,text,uuid)'::regprocedure)) > 0"
      ;;
    *) echo "unknown baseline semantic postcondition: $condition" >&2; exit 1 ;;
  esac
  [[ $(psql_command -Atq -c "$query") == t ]] || { echo "baseline semantic postcondition failed: $condition" >&2; exit 1; }
}

expected_versions=$(mktemp /tmp/heroloop-baseline-expected.XXXXXX)
actual_versions=$(mktemp /tmp/heroloop-baseline-actual.XXXXXX)
trap 'rm -f -- "$expected_versions" "$actual_versions"' EXIT

for file in "$repo"/managed/migrations/*.sql; do
  filename=${file##*/}
  version=${filename%%_*}
  name=${filename#*_}; name=${name%.sql}
  checksum=$(sha256sum "$file" | awk '{print $1}')
  printf '%s\n' "$version" >>"$expected_versions"

  if psql_command -Atq -c "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='$version'" | grep -qx 1; then
    record_checksum "supabase:$version" "$checksum"
    continue
  fi

  if [[ -n ${manifest_hash[$filename]+x} ]]; then
    [[ $checksum == "${manifest_hash[$filename]}" ]] || { echo "manifest SHA-256 mismatch: $filename" >&2; exit 1; }
    verify_satisfied_postcondition "${manifest_condition[$filename]}"
    manifest_seen[$filename]=1
    printf 'satisfied %s (%s)\n' "$filename" "${manifest_condition[$filename]}"
  else
    printf 'apply %s\n' "$filename"
    psql_file "$file"
  fi

  psql_command -q -c "INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ('$version','$name',ARRAY[]::text[])" >/dev/null
  record_checksum "supabase:$version" "$checksum"
done

for filename in "${!manifest_hash[@]}"; do
  [[ -n ${manifest_seen[$filename]+x} || $(psql_command -Atq -c "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${filename%%_*}'") == 1 ]] || {
    echo "unused baseline manifest row: $filename" >&2
    exit 1
  }
done

LC_ALL=C sort -u -o "$expected_versions" "$expected_versions"
psql_command -Atq -c 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version' >"$actual_versions"
diff -u "$expected_versions" "$actual_versions"

for file in "$repo"/selfhosted/postgres/migrations/*.sql; do
  filename=${file##*/}
  version=${filename%.sql}
  checksum=$(sha256sum "$file" | awk '{print $1}')
  existing=$(psql_command -Atq -c "SELECT checksum_sha256 FROM heroloop_migrations.applied_migrations WHERE version='selfhosted:$version'")
  if [[ -n $existing ]]; then
    [[ $existing == "$checksum" ]] || { echo "self-hosted migration checksum mismatch: $filename" >&2; exit 1; }
    continue
  fi
  printf 'apply selfhosted/%s\n' "$filename"
  psql_file "$file"
  record_checksum "selfhosted:$version" "$checksum"
done

printf 'Self-hosted baseline applied: supabase=%s compatibility=%s\n' \
  "$(wc -l <"$expected_versions")" \
  "$(psql_command -Atq -c "SELECT count(*) FROM heroloop_migrations.applied_migrations WHERE version LIKE 'selfhosted:%'")"
