#!/usr/bin/env bash
# One-command environment setup for a fresh Ubuntu cloud container (Claude Code cloud
# sessions run it from the SessionStart hook in .claude/settings.json).
#
# It mirrors what .github/workflows/portal.yml prepares for the "Portal tests (Postgres)" job:
#   - Postgres 16 on localhost:5432, superuser role "keel", database "keel_test",
#     trust auth for local TCP connections (CI: POSTGRES_HOST_AUTH_METHOD=trust)
#   - the pgcrypto extension, created once up front
#   - KEEL_DB_TEST_URL and KEEL_TENANT_CONFIG_PATH, with the CI tenant config file
#   - npm dependencies in engine/ and portal/
# There are no separate migrations: each test file applies the schema in its own
# isolated Postgres schema (engine/test/dbTestHelper.mjs).
#
# Idempotent: every step checks before it changes anything. Prints no secrets (the test
# database needs no password, and the tenant id is the fixed CI test value).
#
# Not covered: Playwright's Chromium for `npm run test:ui` (large download). Install it on
# demand with `cd portal && npx playwright install --with-deps chromium`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_VERSION=16
PG_PORT=5432
DB_USER=keel
DB_NAME=keel_test
KEEL_DB_TEST_URL="postgres://${DB_USER}@localhost:${PG_PORT}/${DB_NAME}"
STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/keel"
KEEL_TENANT_CONFIG_PATH="${STATE_DIR}/ci-tenant.json"

log() { printf '[dev-setup] %s\n' "$*" >&2; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    log "not root and no sudo: cannot manage Postgres"; exit 1
  fi
fi
as_postgres() {
  if [ -z "$SUDO" ]; then runuser -u postgres -- "$@"; else sudo -u postgres "$@"; fi
}

# --- Postgres -------------------------------------------------------------------------
if ! [ -x "/usr/lib/postgresql/${PG_VERSION}/bin/postgres" ]; then
  log "installing postgresql-${PG_VERSION}"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq "postgresql-${PG_VERSION}" postgresql-client >/dev/null
fi

if ! pg_lsclusters -h 2>/dev/null | awk -v v="$PG_VERSION" '$1==v && $2=="main"' | grep -q .; then
  log "creating Postgres ${PG_VERSION} cluster"
  $SUDO pg_createcluster "$PG_VERSION" main --port "$PG_PORT" >/dev/null
fi

# Trust auth over local TCP for all roles, as the CI service container does (tests
# also connect as roles they create).
HBA="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"
HBA_MARK="# keel dev-setup: trust localhost connections (test only)"
if ! $SUDO grep -qF "$HBA_MARK" "$HBA"; then
  log "adding localhost trust rules to pg_hba.conf"
  tmp="$(mktemp)"
  {
    echo "$HBA_MARK"
    echo "host    all    all    127.0.0.1/32    trust"
    echo "host    all    all    ::1/128         trust"
    $SUDO cat "$HBA"
  } >"$tmp"
  $SUDO cp "$tmp" "$HBA"
  rm -f "$tmp"
  HBA_CHANGED=1
fi

if pg_lsclusters -h | awk -v v="$PG_VERSION" '$1==v && $2=="main" {print $4}' | grep -q online; then
  if [ "${HBA_CHANGED:-0}" = 1 ]; then $SUDO pg_ctlcluster "$PG_VERSION" main reload; fi
else
  log "starting Postgres ${PG_VERSION}"
  $SUDO pg_ctlcluster "$PG_VERSION" main start
fi

for _ in $(seq 1 30); do
  pg_isready -q -h localhost -p "$PG_PORT" && break
  sleep 1
done
pg_isready -q -h localhost -p "$PG_PORT" || { log "Postgres did not become ready"; exit 1; }

# The CI service's POSTGRES_USER is a superuser; tests create roles and schemas.
if [ "$(as_postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'")" != 1 ]; then
  log "creating role ${DB_USER}"
  as_postgres psql -q -c "CREATE ROLE ${DB_USER} LOGIN SUPERUSER"
fi
if [ "$(as_postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" != 1 ]; then
  log "creating database ${DB_NAME}"
  as_postgres psql -q -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}"
fi
# Test files run in parallel and each applies the schema; creating the extension once
# up front avoids a race on CREATE EXTENSION (same step as CI).
PGOPTIONS="-c client_min_messages=warning" psql -q "$KEEL_DB_TEST_URL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" >/dev/null

# --- Tenant config and environment ----------------------------------------------------
mkdir -p "$STATE_DIR"
echo '{"tenantId":"00000000-0000-0000-0000-0000000000c1"}' >"$KEEL_TENANT_CONFIG_PATH"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  touch "$CLAUDE_ENV_FILE"
  for line in "export KEEL_DB_TEST_URL=\"${KEEL_DB_TEST_URL}\"" \
              "export KEEL_TENANT_CONFIG_PATH=\"${KEEL_TENANT_CONFIG_PATH}\""; do
    grep -qxF "$line" "$CLAUDE_ENV_FILE" || echo "$line" >>"$CLAUDE_ENV_FILE"
  done
fi

# --- npm dependencies (same folders and order as CI) ----------------------------------
# npm ci only when the lockfile changed since the last install, so reruns are fast.
for dir in engine portal; do
  lock="${REPO_ROOT}/${dir}/package-lock.json"
  stamp="${REPO_ROOT}/${dir}/node_modules/.dev-setup-lock.sha256"
  want="$(sha256sum "$lock" | cut -d' ' -f1)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    log "${dir}: node_modules up to date"
  else
    log "${dir}: npm ci"
    (cd "${REPO_ROOT}/${dir}" && npm ci --no-audit --no-fund --loglevel=error >&2)
    echo "$want" >"$stamp"
  fi
done

log "ready. In a shell outside Claude Code, set:"
log "  export KEEL_DB_TEST_URL=${KEEL_DB_TEST_URL}"
log "  export KEEL_TENANT_CONFIG_PATH=${KEEL_TENANT_CONFIG_PATH}"
