#!/usr/bin/env bash
# Run the HeroLoop Seeker backend (Postgres, Auth, wallet Auth, API, worker, SKR ledger) locally with Docker.
# usage: scripts/clockin-local-backend.sh up|down|status
# Secrets are generated into selfhosted/clockin.env.local (git-ignored). Ports: HL_LOCAL_API_PORT (28081),
# HL_LOCAL_AUTH_PORT (29999), HL_LOCAL_DB_PORT (25432); project name: HL_LOCAL_PROJECT (heroloop-clockin-local).
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
action=${1:-up}
project=${HL_LOCAL_PROJECT:-heroloop-clockin-local}
api_port=${HL_LOCAL_API_PORT:-28081}; auth_port=${HL_LOCAL_AUTH_PORT:-29999}
export HL_LOCAL_API_PORT=$api_port HL_LOCAL_AUTH_PORT=$auth_port HL_LOCAL_DB_PORT=${HL_LOCAL_DB_PORT:-25432}
env_file=$repo/selfhosted/clockin.env.local
storage=$repo/selfhosted/.clockin-storage
docker=(docker)
# sudo drops the caller's environment, so pass the port overrides through explicitly.
docker info >/dev/null 2>&1 || docker=(sudo -n env "HL_LOCAL_API_PORT=$HL_LOCAL_API_PORT" "HL_LOCAL_AUTH_PORT=$HL_LOCAL_AUTH_PORT" "HL_LOCAL_DB_PORT=$HL_LOCAL_DB_PORT" docker)
compose() { "${docker[@]}" compose --project-name "$project" --env-file "$env_file" --file "$repo/selfhosted/compose.yml" --file "$repo/selfhosted/compose.local.yml" --profile wallet-auth "$@"; }

if [[ ! -f $env_file ]]; then
  mkdir -p "$storage"; chmod 0777 "$storage"
  node --input-type=module - "$env_file" "$storage" "$auth_port" <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [file, storage, authPort] = process.argv.slice(2);
const secret = () => randomBytes(48).toString('base64url');
const jwtSecret = secret();
const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const keys = [{ ...jwk, kid: randomBytes(16).toString('hex'), use: 'sig', key_ops: ['sign', 'verify'], alg: 'ES256', ext: true },
  { kty: 'oct', k: Buffer.from(jwtSecret).toString('base64url'), alg: 'HS256' }];
const site = 'http://localhost:5173';
writeFileSync(file, [
  `POSTGRES_PASSWORD=${secret()}`, `API_DATABASE_PASSWORD=${secret()}`, `WORKER_DATABASE_PASSWORD=${secret()}`,
  `JWT_SECRET=${jwtSecret}`, `JWT_KEYS=${JSON.stringify(keys)}`, 'JWT_EXPIRY=3600',
  `API_EXTERNAL_URL=http://localhost:${authPort}`, `SITE_URL=${site}`, `ADDITIONAL_REDIRECT_URLS=${site}/**`,
  `STORAGE_DATA_PATH=${storage}`, 'SIWS_CHALLENGE_ENABLED=true', 'SIWS_VERIFICATION_ENABLED=true',
  'SIWS_ACCOUNT_LOGIN_ENABLED=true', 'SIWS_CHAIN_ID=solana:mainnet', 'SIWS_DOMAIN=localhost:5173', `SIWS_URI=${site}/`,
  `SIWS_HASH_PEPPER=${secret()}`, '',
].join('\n'), { mode: 0o600 });
JS
  echo "Generated $env_file"
fi

case $action in
  up)
    compose config --quiet
    compose up --detach --wait postgres
    container=$(compose ps --quiet postgres)
    psql() { compose exec -T postgres psql -U supabase_admin -X -q -v ON_ERROR_STOP=1 "$@"; }
    psql -d postgres <"$repo/selfhosted/postgres/init/zz-heroloop-bootstrap.sql"
    for initializer in zzza-heroloop-auth-password.sh zzz-heroloop-api-password.sh zzzz-heroloop-worker-password.sh; do
      compose exec -T postgres bash "/docker-entrypoint-initdb.d/$initializer" >/dev/null
    done
    "$repo/scripts/apply-selfhosted-baseline.sh" "$container"
    # The Seeker client requires its explicit policy, which is excluded from the shared baseline.
    if [[ $(psql -d postgres -Atc "SELECT to_regclass('public.seeker_progression_settings') IS NOT NULL") != t ]]; then
      psql -d postgres -c "SET heroloop.edition = 'seeker'" -f - <"$repo/selfhosted/postgres/manual/seeker-progression-200.sql"
    fi
    [[ $(psql -d postgres -Atc "SELECT version FROM public.seeker_progression_settings WHERE singleton") == seeker-progression-200-v1 ]] || {
      echo 'ERROR: local Seeker progression version does not match this client' >&2
      exit 1
    }
    # The SKR ledger lives in its own database, never inside the game database.
    [[ $(psql -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname='seeker_skr'") != 0 ]] || psql -d postgres -c 'CREATE DATABASE seeker_skr OWNER supabase_admin'
    [[ $(psql -d seeker_skr -Atc "SELECT to_regclass('seeker_skr.events') IS NOT NULL") == t ]] || psql -d seeker_skr <"$repo/selfhosted/seeker/ledger.sql"
    compose up --detach --wait auth auth-wallet api worker
    curl --fail --silent --max-time 10 "http://127.0.0.1:$api_port/api/v1/health" >/dev/null
    curl --fail --silent --max-time 10 "http://127.0.0.1:$auth_port/health" >/dev/null
    echo "Backend ready: API http://127.0.0.1:$api_port  Auth http://127.0.0.1:$auth_port"
    ;;
  status) compose ps ;;
  down) compose down --volumes; echo "Stopped and removed $project (data volumes deleted; $env_file kept)" ;;
  *) echo 'usage: clockin-local-backend.sh up|down|status' >&2; exit 2 ;;
esac
