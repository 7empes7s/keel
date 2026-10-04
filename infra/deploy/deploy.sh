#!/usr/bin/env bash
# KEEL live-portal auto-deploy. Run by keel-deploy.timer every 5 minutes.
#
# Deploys origin/master to /opt/keel-live only when the Portal workflow (portal.yml) concluded
# success on that exact commit. Order: checkout -> npm ci -> build -> schema -> restart -> health.
# The build runs before the schema so a failed build never leaves the database ahead of the code.
# Before building, the running tree is copied to $PREV (the previous release). Build, schema,
# restart or health failure swaps that copy back into place and restarts it, so a rollback needs
# no rebuild. Only if no usable copy exists does it fall back to rebuilding the previous commit.
# Health = local /api/health returns ok AND the public status page returns 200, retried ~60s.
# Rollbacks, refusals and critical failures are also written to the AI vault daily note.
#
# Test switch: KEEL_DEPLOY_FORCE_HEALTH_FAIL=1 makes the health check of the new release fail,
# to prove the rollback path. It also skips the vps-deployer hand-off (the log says TEST).
#
# Git: fetch plus `checkout --detach <verified sha>` only. No merge, reset, push or branch moves,
# so history is never touched and the deployed tree is exactly the commit CI verified.
# Schema: engine/store/schema.sql is idempotent and additive. A pg_dump is taken whenever it
# changed, and a schema diff that adds a destructive statement is refused for manual review.
# One-time migrations (cli/keel-schedules-migrate.mjs) are operator actions and are never run here.
set -Eeuo pipefail

REPO=7empes7s/keel
LIVE=/opt/keel-live
UNIT=keel-portal
HEALTH_URL=http://127.0.0.1:3600/api/health
PUBLIC_URL=https://keel.techinsiderbytes.com/status/
PREV=/opt/keel-live.prev          # the previous release, kept until the next deploy
FAILED_TREE=/opt/keel-live.failed # the last rolled-back tree, kept for inspection
VAULT=/opt/ai-vault/daily
FORCE_FAIL="${KEEL_DEPLOY_FORCE_HEALTH_FAIL:-0}"
CONTEXT=keel/live-deploy
STATE=/var/lib/keel-deploy
LOG=/var/log/keel-deploy.log
LOCK=/run/lock/keel-deploy.lock
BACKUPS=/root/backups/keel-deploy
KEEP_DUMPS=5
GENERATED=portal/next-env.d.ts   # rewritten by every `next build`; the only dirt tolerated

# Token from /etc/keel/gh.env (mode 600), read at run time so a rotation is picked up.
GH_TOKEN="${GH_TOKEN:-$(grep -m1 '^GH_TOKEN=' /etc/keel/gh.env | cut -d= -f2-)}"
export GH_TOKEN
mkdir -p "$STATE/failed" "$BACKUPS"
exec 9>"$LOCK"
flock -n 9 || exit 0   # a run is already in progress

log() { printf '%s %s\n' "$(date -u '+%F %T')" "$*" >> "$LOG"; }
trap 'log "ERROR: line $LINENO exited $? (unexpected)"' ERR
# Log a skip reason once per (sha, reason), so idle ticks do not grow the log.
note_once() {
  local key="$1:$2"
  [ "$(cat "$STATE/last-note" 2>/dev/null)" = "$key" ] && return 0
  echo "$key" > "$STATE/last-note"
  log "$3"
}
post_status() {  # sha state description
  timeout 30 gh api -X POST "repos/$REPO/statuses/$1" -f state="$2" -f context="$CONTEXT" \
    -f description="${3:0:139}" >/dev/null 2>>"$LOG" || log "WARN: could not post $2 status on ${1:0:7}"
}
# Hand a real event (never an idle tick) to the vps-deployer Claude session for follow-up.
agent() {
  if [ "$FORCE_FAIL" = 1 ]; then log "TEST: agent event '$1' not sent"; return 0; fi
  /opt/keel-deploy/notify-agent.sh "$@" || true
}
vault() {  # one entry in today's AI-vault daily note; never fails the deploy
  { printf '\n## %s UTC - keel-deploy: %s\n' "$(date -u +%H:%M)" "$*" >> "$VAULT/$(date -u +%F).md"; } 2>/dev/null || true
}

cd "$LIVE"
git fetch -q origin master
TARGET=$(git rev-parse origin/master)
CURRENT=$(git rev-parse HEAD)
[ "$TARGET" = "$CURRENT" ] && exit 0

if [ -e "$STATE/failed/$TARGET" ]; then
  note_once "$TARGET" failed "skip ${TARGET:0:7}: deploy already failed and was rolled back (rm $STATE/failed/$TARGET to retry)"
  exit 0
fi

# CI gate: the newest push run of portal.yml on this exact commit.
RUN=$(gh run list -R "$REPO" --workflow portal.yml --commit "$TARGET" --event push --limit 1 \
        --json status,conclusion,databaseId --jq '.[0] // empty | [.status, .conclusion, .databaseId] | @tsv')
if [ -z "$RUN" ]; then
  note_once "$TARGET" no-run "wait ${TARGET:0:7}: no portal.yml push run on this commit (path filter or not started yet)"
  exit 0
fi
IFS=$'\t' read -r RUN_STATUS RUN_CONCLUSION RUN_ID <<< "$RUN"
if [ "$RUN_STATUS" != completed ]; then
  note_once "$TARGET" "ci-$RUN_STATUS" "wait ${TARGET:0:7}: CI run $RUN_ID is $RUN_STATUS"
  exit 0
fi
if [ "$RUN_CONCLUSION" != success ]; then
  note_once "$TARGET" "ci-$RUN_CONCLUSION" "skip ${TARGET:0:7}: CI run $RUN_ID concluded $RUN_CONCLUSION"
  exit 0
fi

# The live tree must be clean apart from the generated file; anything else is a hand edit.
git checkout -q -- "$GENERATED" 2>/dev/null || true
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  touch "$STATE/failed/$TARGET"   # refuse once, not every tick
  log "REFUSE ${TARGET:0:7}: $LIVE has local modifications: $(git status --porcelain --untracked-files=no | tr '\n' ' ')"
  post_status "$TARGET" failure "Refused: live tree has local modifications"
  vault "REFUSED ${TARGET:0:7}: live tree has local modifications"
  agent refused "$TARGET" "live tree $LIVE has local modifications; deploy skipped"
  exit 1
fi

# Schema guard, before anything changes.
SCHEMA_CHANGED=0
if ! git diff --quiet "$CURRENT" "$TARGET" -- engine/store/schema.sql; then
  SCHEMA_CHANGED=1
  if git diff "$CURRENT" "$TARGET" -- engine/store/schema.sql \
       | grep -E '^\+' | grep -qiE '\b(DROP[[:space:]]+(TABLE|COLUMN|SCHEMA|TYPE)|TRUNCATE|DELETE[[:space:]]+FROM)\b'; then
    touch "$STATE/failed/$TARGET"
    log "REFUSE ${TARGET:0:7}: schema diff adds a destructive statement; deploy manually"
    post_status "$TARGET" failure "Refused: schema change adds a destructive statement"
    vault "REFUSED ${TARGET:0:7}: schema diff adds a destructive statement"
    agent refused "$TARGET" "schema diff adds a destructive statement; needs manual review"
    exit 1
  fi
fi

# Every step is &&-chained: callers use `build_at ... || rollback`, which disables set -e inside.
build_at() {  # sha: check out, install, build
  { git checkout -q -- "$GENERATED" 2>/dev/null || true; } &&
  git checkout -q --detach "$1" &&
  (cd engine && npm ci --no-audit --no-fund --loglevel=error) &&
  (cd portal && npm ci --no-audit --no-fund --loglevel=error && npm run build)
}
healthy() {  # ~60s: local health ok and the public status page 200
  for _ in $(seq 1 20); do
    if [ "$(curl -s -m 5 "$HEALTH_URL" 2>/dev/null)" = '{"status":"ok"}' ] &&
       [ "$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$PUBLIC_URL" 2>/dev/null)" = 200 ]; then
      return 0
    fi
    sleep 3
  done
  return 1
}
release_healthy() {  # health of the newly deployed release; the test switch fails it
  if [ "$FORCE_FAIL" = 1 ]; then log "TEST: KEEL_DEPLOY_FORCE_HEALTH_FAIL=1, forcing health failure"; return 1; fi
  healthy
}
restore_prev() {  # swap the saved previous release back into place
  [ "$(cat "$STATE/prev-sha" 2>/dev/null)" = "$CURRENT" ] && [ -d "$PREV/.git" ] || return 1
  systemctl stop "$UNIT" || true
  cd / &&
  rm -rf "$FAILED_TREE" &&
  mv "$LIVE" "$FAILED_TREE" &&
  mv "$PREV" "$LIVE" &&
  cd "$LIVE" &&
  systemctl start "$UNIT"
}
rollback() {  # reason
  log "ROLLBACK ${TARGET:0:7} -> ${CURRENT:0:7}: $1"
  touch "$STATE/failed/$TARGET"
  local how=""
  if restore_prev >> "$LOG" 2>&1; then
    how="restored saved release"
  else
    log "no usable saved release; rebuilding ${CURRENT:0:7}"
    if cd "$LIVE" && build_at "$CURRENT" >> "$LOG" 2>&1 && systemctl restart "$UNIT"; then how="rebuilt"; fi
  fi
  if [ -n "$how" ] && healthy; then
    log "rollback ok ($how): live is ${CURRENT:0:7}, health ok"
    post_status "$TARGET" failure "Deploy failed ($1); rolled back to ${CURRENT:0:7}"
    vault "ROLLED BACK ${TARGET:0:7} -> ${CURRENT:0:7} ($1; $how; health ok)$([ "$FORCE_FAIL" = 1 ] && echo ' [TEST]')"
    agent rolled-back "$TARGET" "$1; live restored to ${CURRENT:0:7}"
  else
    log "CRITICAL: rollback to ${CURRENT:0:7} failed (${how:-restore and rebuild failed}); the portal needs manual attention"
    post_status "$TARGET" failure "Deploy failed ($1); rollback to ${CURRENT:0:7} FAILED"
    vault "CRITICAL ${TARGET:0:7}: $1, then rollback to ${CURRENT:0:7} failed; portal may be down"
    agent critical "$TARGET" "$1, then rollback to ${CURRENT:0:7} also failed; portal may be down"
  fi
  exit 1
}

log "deploy ${CURRENT:0:7} -> ${TARGET:0:7} (CI run $RUN_ID success)"
post_status "$TARGET" pending "Deploying to the live portal"

# Keep the running tree as the previous release, for a no-rebuild rollback. $STATE/prev-sha is
# written only after a complete copy, so a half-written copy is never restored. Nothing has
# changed yet if the copy fails, so that aborts (and retries next tick) instead of rolling back.
rm -f "$STATE/prev-sha"
if ! { rm -rf "$PREV" && cp -a "$LIVE" "$PREV"; }; then
  rm -rf "$PREV"
  log "ABORT ${TARGET:0:7}: could not save the previous release to $PREV (disk?); live untouched"
  post_status "$TARGET" error "Not deployed: could not save the previous release"
  exit 1
fi
echo "$CURRENT" > "$STATE/prev-sha"
log "saved previous release ${CURRENT:0:7} to $PREV"

build_at "$TARGET" >> "$LOG" 2>&1 || rollback "build failed"

if [ "$SCHEMA_CHANGED" = 1 ]; then
  DUMP="$BACKUPS/keel-${CURRENT:0:7}-$(date -u +%Y%m%d%H%M).sql.gz"
  docker exec keel-postgres pg_dump -U keel -d keel | gzip > "$DUMP" || rollback "pre-schema pg_dump failed"
  log "schema changed: dumped live DB to $DUMP"
  ls -1t "$BACKUPS"/keel-*.sql.gz | tail -n +$((KEEP_DUMPS + 1)) | xargs -r rm -f
fi
# Always applied: idempotent, one transaction, so a partial failure changes nothing.
docker exec -i keel-postgres psql -U keel -d keel -v ON_ERROR_STOP=1 -1 -q \
  < engine/store/schema.sql >> "$LOG" 2>&1 || rollback "schema apply failed"

systemctl restart "$UNIT" || rollback "service restart failed"
release_healthy || rollback "health check failed"

rm -f "$STATE/last-note"
log "deployed ${TARGET:0:7}: health ok"
post_status "$TARGET" success "Live on keel.techinsiderbytes.com"
agent deployed "$TARGET" "deployed from ${CURRENT:0:7}, CI run $RUN_ID, health ok"
