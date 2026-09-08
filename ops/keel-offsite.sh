#!/usr/bin/env bash
#
# keel-offsite.sh — ship the most recent KEEL database dump to the offsite host.
#
# WHY: /opt/mimoun/backup.sh dumps the KEEL database nightly into
# /opt/backups/<YYYY-MM-DD>/keel-db.sql.gz, but that dump lives on the same VPS as the
# database it protects. If this host is lost, every tenant baseline is lost with it.
# This script replicates the dump to a second, independent VPS (Hostinger,
# 187.124.7.67) so a host loss does not also destroy the only copy of the backup.
#
# A corrupt or truncated dump shipped offsite is worse than no dump at all, because it
# looks like protection when it is not. Every step that can silently fail is checked
# explicitly and the script exits non-zero (with `set -e` + no `|| true` anywhere) so
# systemd reports failure loudly.
#
# Usage:
#   keel-offsite.sh             # verify + ship + prune
#   keel-offsite.sh --dry-run   # verify + report what would ship, ship nothing

set -euo pipefail

BACKUP_ROOT="${KEEL_OFFSITE_BACKUP_ROOT:-/opt/backups}"
REMOTE_USER_HOST="root@187.124.7.67"
SSH_KEY="/root/.ssh/playground_vps"
REMOTE_DIR="/opt/keel-offsite"
RETENTION_DAYS=30
MIN_COPY_BLOCKS=5

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    *)
      echo "keel-offsite: unknown argument: $arg" >&2
      echo "usage: keel-offsite.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15)

log() {
  echo "[$(date -Iseconds)] $*"
}

fail() {
  echo "[$(date -Iseconds)] ERROR: $*" >&2
  exit 1
}

# --- locate the most recent dump -------------------------------------------------

LATEST_DATE_DIR=""
LATEST_DATE=""
for d in "$BACKUP_ROOT"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  [ -d "$d" ] || continue
  candidate="$d/keel-db.sql.gz"
  [ -f "$candidate" ] || continue
  this_date="$(basename "$d")"
  if [ -z "$LATEST_DATE" ] || [[ "$this_date" > "$LATEST_DATE" ]]; then
    LATEST_DATE="$this_date"
    LATEST_DATE_DIR="$d"
  fi
done

if [ -z "$LATEST_DATE_DIR" ]; then
  fail "no keel-db.sql.gz found under $BACKUP_ROOT/<YYYY-MM-DD>/"
fi

LOCAL_DUMP="$LATEST_DATE_DIR/keel-db.sql.gz"
REMOTE_NAME="keel-db-${LATEST_DATE}.sql.gz"

log "candidate dump: $LOCAL_DUMP (dated $LATEST_DATE)"

# --- verify BEFORE shipping -------------------------------------------------------
# A backup on the host it protects is not a backup; shipping a corrupt one offsite
# is worse than shipping nothing, because it looks like protection.

if ! gzip -t "$LOCAL_DUMP"; then
  fail "$LOCAL_DUMP failed 'gzip -t' — dump is corrupt, shipping nothing"
fi
log "gzip integrity check passed"

# grep -c exits 1 (not an error) when it finds zero matches, and that would otherwise
# trip `set -e` before we get a chance to report a clear message. Capture the status
# explicitly instead of masking it with `|| true`.
set +e
COPY_BLOCKS="$(zcat "$LOCAL_DUMP" | grep -c '^COPY public')"
GREP_EXIT=$?
set -e

if [ "$GREP_EXIT" -gt 1 ]; then
  fail "failed to scan $LOCAL_DUMP for COPY blocks (zcat|grep exited $GREP_EXIT) — dump unreadable, shipping nothing"
fi
if [ "$COPY_BLOCKS" -lt "$MIN_COPY_BLOCKS" ]; then
  fail "$LOCAL_DUMP has only $COPY_BLOCKS '^COPY public' block(s), need >= $MIN_COPY_BLOCKS — dump looks incomplete, shipping nothing"
fi
log "content check passed: $COPY_BLOCKS COPY blocks (>= $MIN_COPY_BLOCKS required)"

set +e
LOCAL_SHA256="$(sha256sum "$LOCAL_DUMP" | awk '{print $1}')"
LOCAL_SHA_STATUS=$?
set -e
if [ "$LOCAL_SHA_STATUS" -ne 0 ] || [ -z "$LOCAL_SHA256" ]; then
  fail "could not compute local sha256 for $LOCAL_DUMP (sha256sum exited $LOCAL_SHA_STATUS)"
fi
log "local sha256: $LOCAL_SHA256"

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN: verification passed. Would ship $LOCAL_DUMP -> $REMOTE_USER_HOST:$REMOTE_DIR/$REMOTE_NAME"
  log "DRY RUN: would prune remote copies older than $RETENTION_DAYS days"
  log "DRY RUN: transferring nothing"
  exit 0
fi

# --- confirm remote reachability + destination directory --------------------------

if ! ssh "${SSH_OPTS[@]}" "$REMOTE_USER_HOST" "mkdir -p '$REMOTE_DIR'"; then
  fail "could not reach $REMOTE_USER_HOST or create $REMOTE_DIR remotely"
fi
log "remote host reachable, $REMOTE_DIR present"

# --- ship -----------------------------------------------------------------------

REMOTE_TMP="${REMOTE_DIR}/.${REMOTE_NAME}.partial"
REMOTE_PATH="${REMOTE_DIR}/${REMOTE_NAME}"

if ! scp "${SSH_OPTS[@]}" "$LOCAL_DUMP" "${REMOTE_USER_HOST}:${REMOTE_TMP}"; then
  fail "scp of $LOCAL_DUMP to ${REMOTE_USER_HOST}:${REMOTE_TMP} failed"
fi
log "scp transfer completed (staged as $REMOTE_TMP)"

# --- verify AFTER transfer --------------------------------------------------------
# Do not trust scp's exit code alone: compute sha256 remotely and compare.

set +e
REMOTE_SHA256="$(ssh "${SSH_OPTS[@]}" "$REMOTE_USER_HOST" "sha256sum '$REMOTE_TMP'" | awk '{print $1}')"
REMOTE_SHA_STATUS=$?
set -e
if [ "$REMOTE_SHA_STATUS" -ne 0 ] || [ -z "$REMOTE_SHA256" ]; then
  fail "could not compute remote sha256 for $REMOTE_TMP (ssh/sha256sum exited $REMOTE_SHA_STATUS)"
fi
log "remote sha256: $REMOTE_SHA256"

if [ "$LOCAL_SHA256" != "$REMOTE_SHA256" ]; then
  if ! ssh "${SSH_OPTS[@]}" "$REMOTE_USER_HOST" "rm -f '$REMOTE_TMP'"; then
    echo "[$(date -Iseconds)] WARN: could not remove partial remote file $REMOTE_TMP after sha256 mismatch — clean it up manually" >&2
  fi
  fail "sha256 mismatch after transfer (local=$LOCAL_SHA256 remote=$REMOTE_SHA256) — shipping considered FAILED"
fi
log "sha256 verified — transfer is byte-identical"

# Atomically promote the verified staging file into place.
if ! ssh "${SSH_OPTS[@]}" "$REMOTE_USER_HOST" "mv '$REMOTE_TMP' '$REMOTE_PATH'"; then
  fail "could not promote $REMOTE_TMP to $REMOTE_PATH on remote host"
fi
log "offsite copy in place: ${REMOTE_USER_HOST}:${REMOTE_PATH}"

# --- prune remote copies older than retention -------------------------------------

PRUNE_CMD='find '"$REMOTE_DIR"' -maxdepth 1 -type f -name "keel-db-*.sql.gz" -mtime +'"$RETENTION_DAYS"' -print -delete'
set +e
PRUNED="$(ssh "${SSH_OPTS[@]}" "$REMOTE_USER_HOST" "$PRUNE_CMD")"
PRUNE_STATUS=$?
set -e
if [ "$PRUNE_STATUS" -ne 0 ]; then
  fail "remote prune of copies older than ${RETENTION_DAYS}d failed on $REMOTE_USER_HOST (exit $PRUNE_STATUS) — the new dump shipped successfully, but retention cleanup did not run"
fi
if [ -n "$PRUNED" ]; then
  log "pruned remote copies older than ${RETENTION_DAYS}d:"
  echo "$PRUNED" | while IFS= read -r line; do log "  removed: $line"; done
else
  log "no remote copies older than ${RETENTION_DAYS}d to prune"
fi

log "keel-offsite: done. Shipped $REMOTE_NAME, sha256 $LOCAL_SHA256"
