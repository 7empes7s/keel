#!/usr/bin/env bash
#
# keel-offsite.sh — ship the most recent KEEL database dump off the VPS root disk.
#
# WHY: /opt/mimoun/backup.sh dumps the KEEL database nightly into
# /opt/backups/<YYYY-MM-DD>/keel-db.sql.gz, but that dump lives on the same VPS as the
# database it protects. If this host is lost, every tenant baseline is lost with it.
# This script replicates the dump to storage that outlives the VPS: by default the
# persistent Hetzner volume mounted at /mnt/keel-copy ("vol2"), which survives the
# server being rebuilt or deleted. The earlier target, a Hostinger VPS at
# 187.124.7.67, stopped answering (issue #89); a remote host can still be used via
# KEEL_OFFSITE_REMOTE.
#
# A corrupt or truncated dump shipped offsite is worse than no dump at all, because it
# looks like protection when it is not. Every step that can silently fail is checked
# explicitly and the script exits non-zero (with `set -e` + no `|| true` anywhere) so
# systemd reports failure loudly.
#
# Usage:
#   keel-offsite.sh             # verify + ship + prune
#   keel-offsite.sh --dry-run   # verify + check the target is usable, ship nothing
#
# Target settings, all optional, for example in /etc/keel/offsite.env (read by the unit):
#   KEEL_OFFSITE_DIR      destination directory (default /mnt/keel-copy/keel-offsite)
#   KEEL_OFFSITE_REMOTE   user@host; when set, ship over SSH instead of to a local volume
#   KEEL_OFFSITE_SSH_KEY  SSH key for KEEL_OFFSITE_REMOTE (default /root/.ssh/playground_vps)

set -euo pipefail
# The dump holds every tenant baseline: keep the staged and promoted copies root-only.
umask 077

BACKUP_ROOT="${KEEL_OFFSITE_BACKUP_ROOT:-/opt/backups}"
REMOTE_USER_HOST="${KEEL_OFFSITE_REMOTE:-}"
SSH_KEY="${KEEL_OFFSITE_SSH_KEY:-/root/.ssh/playground_vps}"
REMOTE_DIR="${KEEL_OFFSITE_DIR:-/mnt/keel-copy/keel-offsite}"
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

# The rest of the script talks to the target only through these two helpers, so a
# local volume and a remote host go through the same verify/stage/promote/prune steps.
if [ -n "$REMOTE_USER_HOST" ]; then
  TARGET="$REMOTE_USER_HOST:$REMOTE_DIR"
  on_target() { ssh "${SSH_OPTS[@]}" "$REMOTE_USER_HOST" "$1"; }
  copy_to_target() { scp "${SSH_OPTS[@]}" "$1" "${REMOTE_USER_HOST}:$2"; }
else
  TARGET="$REMOTE_DIR"
  on_target() { bash -c "$1"; }
  copy_to_target() { cp -- "$1" "$2" && sync -f "$2"; }
fi

log() {
  echo "[$(date -Iseconds)] $*"
}

fail() {
  echo "[$(date -Iseconds)] ERROR: $*" >&2
  exit 1
}

# --- locate the most recent dump -------------------------------------------------

# Serialize verification through durable shipment recording, including manual runs.
exec 9>"$BACKUP_ROOT/.keel-offsite.lock"
flock -x 9
MANIFEST_TOOL="$(dirname "$(readlink -f "$0")")/../engine/schedules/offsite.mjs"
SHIPPED_MANIFEST="$BACKUP_ROOT/keel-db-shipped-manifest.json"
PINNED_MANIFEST="$(mktemp "$BACKUP_ROOT/.keel-offsite-manifest.XXXXXX")"
trap 'rm -f "$PINNED_MANIFEST"' EXIT
cp "$BACKUP_ROOT/keel-db-manifest.json" "$PINNED_MANIFEST"
LOCAL_DUMP="$(node "$MANIFEST_TOOL" verify "$PINNED_MANIFEST" "$SHIPPED_MANIFEST")"
LATEST_DATE="$(basename "$(dirname "$LOCAL_DUMP")")"
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
MANIFEST_SHA256="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).checksum)' "$PINNED_MANIFEST")"
[ "$LOCAL_SHA256" = "$MANIFEST_SHA256" ] || fail "dump changed after manifest verification"

# --- confirm the target is usable -------------------------------------------------
# A local target must sit on a different filesystem than the dump. The volume is
# mounted with `nofail`, so if it is missing at boot /mnt/keel-copy is just an empty
# directory on the root disk, and copying there would look like protection while
# adding none.

REMOTE_PARENT="$(dirname "$REMOTE_DIR")"
if [ -z "$REMOTE_USER_HOST" ]; then
  [ -d "$REMOTE_PARENT" ] || fail "$REMOTE_PARENT does not exist — is the offsite volume mounted?"
  if [ "$(stat -c %d "$REMOTE_PARENT")" = "$(stat -c %d "$BACKUP_ROOT")" ]; then
    fail "$REMOTE_PARENT is on the same filesystem as $BACKUP_ROOT — the offsite volume is not mounted, shipping nothing"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY RUN: verification passed. Would ship $LOCAL_DUMP -> $TARGET/$REMOTE_NAME"
  # A dry run that never touches the target reports success while every real run
  # fails, which hid an unreachable host (issue #89). Probe it read-only.
  if ! on_target "test -d '$REMOTE_DIR' || test -w '$REMOTE_PARENT'"; then
    fail "DRY RUN: target unreachable, or neither $REMOTE_DIR exists nor $REMOTE_PARENT is writable — a real run would fail"
  fi
  log "DRY RUN: target $TARGET usable"
  log "DRY RUN: would prune offsite copies older than $RETENTION_DAYS days"
  log "DRY RUN: transferring nothing"
  exit 0
fi

# --- confirm target reachability + destination directory --------------------------

if ! on_target "mkdir -p '$REMOTE_DIR'"; then
  fail "could not reach the target or create $TARGET"
fi
log "target reachable, $TARGET present"

# --- ship -----------------------------------------------------------------------

REMOTE_TMP="${REMOTE_DIR}/.${REMOTE_NAME}.partial"
REMOTE_PATH="${REMOTE_DIR}/${REMOTE_NAME}"

if ! copy_to_target "$LOCAL_DUMP" "$REMOTE_TMP"; then
  fail "copy of $LOCAL_DUMP to $TARGET (staged as $REMOTE_TMP) failed"
fi
log "transfer completed (staged as $REMOTE_TMP)"

# --- verify AFTER transfer --------------------------------------------------------
# Do not trust the copy's exit code alone: hash the staged file on the target and compare.

set +e
REMOTE_SHA256="$(on_target "sha256sum '$REMOTE_TMP'" | awk '{print $1}')"
REMOTE_SHA_STATUS=$?
set -e
if [ "$REMOTE_SHA_STATUS" -ne 0 ] || [ -z "$REMOTE_SHA256" ]; then
  fail "could not compute remote sha256 for $REMOTE_TMP (ssh/sha256sum exited $REMOTE_SHA_STATUS)"
fi
log "target sha256: $REMOTE_SHA256"

if [ "$LOCAL_SHA256" != "$REMOTE_SHA256" ]; then
  if ! on_target "rm -f '$REMOTE_TMP'"; then
    echo "[$(date -Iseconds)] WARN: could not remove partial remote file $REMOTE_TMP after sha256 mismatch — clean it up manually" >&2
  fi
  fail "sha256 mismatch after transfer (local=$LOCAL_SHA256 target=$REMOTE_SHA256) — shipping considered FAILED"
fi
log "sha256 verified — transfer is byte-identical"

# Atomically promote the verified staging file into place.
if ! on_target "mv '$REMOTE_TMP' '$REMOTE_PATH'"; then
  fail "could not promote $REMOTE_TMP to $REMOTE_PATH on the target"
fi
log "offsite copy in place: $TARGET/$REMOTE_NAME"
node "$MANIFEST_TOOL" record "$PINNED_MANIFEST" "$SHIPPED_MANIFEST"

# --- prune offsite copies older than retention -------------------------------------

PRUNE_CMD='find '"$REMOTE_DIR"' -maxdepth 1 -type f -name "keel-db-*.sql.gz" -mtime +'"$RETENTION_DAYS"' -print -delete'
set +e
PRUNED="$(on_target "$PRUNE_CMD")"
PRUNE_STATUS=$?
set -e
if [ "$PRUNE_STATUS" -ne 0 ]; then
  fail "prune of offsite copies older than ${RETENTION_DAYS}d failed on $TARGET (exit $PRUNE_STATUS) — the new dump shipped successfully, but retention cleanup did not run"
fi
if [ -n "$PRUNED" ]; then
  log "pruned offsite copies older than ${RETENTION_DAYS}d:"
  echo "$PRUNED" | while IFS= read -r line; do log "  removed: $line"; done
else
  log "no offsite copies older than ${RETENTION_DAYS}d to prune"
fi

log "keel-offsite: done. Shipped $REMOTE_NAME, sha256 $LOCAL_SHA256"
