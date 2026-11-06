#!/bin/bash
# Nightly host backup (mimule-backup.timer, 04:00 UTC): the KEEL database dump, KEEL config,
# unit files and the Caddyfile, one folder per day under /opt/backups/<YYYY-MM-DD>/.
# Installed from the repo (#1024): install -m 755 ops/mimule-backup.sh /usr/local/bin/
#
# keel-offsite.sh, keel-dump-manifest.mjs and the recovery runbook read the dump at
# /opt/backups/<YYYY-MM-DD>/keel-db.sql.gz, so the dump is dated by its folder.
set -euo pipefail

BACKUP_DIR="${KEEL_BACKUP_DIR:-/opt/backups}"
DATE="${KEEL_BACKUP_DATE:-$(date +%Y-%m-%d)}"
BACKUP_PATH="$BACKUP_DIR/$DATE"
KEEP_DAILY=7

# Keep the newest $2 dated sets under $1. Only YYYY-MM-DD folders are eligible, so other
# files and folders under it (manifests, cleanup archives) are never touched.
rotate_dated_sets() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]' \
    | sort -r | tail -n +$(($2 + 1)) | xargs -r rm -rf --
}

main() {
  mkdir -p "$BACKUP_PATH"

  echo "[$(date -Iseconds)] Starting backup..."

  # Caddy config
  cp /etc/caddy/Caddyfile "$BACKUP_PATH/Caddyfile" 2>/dev/null || true

  # KEEL database — the disaster-recovery store. Deliberately NOT "|| true": if this
  # fails silently we lose every tenant baseline and only find out during an incident.
  # The dump is written beside its final name and moved into place only once verified,
  # so a failed run never overwrites a good dump of the same day.
  local dump="$BACKUP_PATH/keel-db.sql.gz" partial="$BACKUP_PATH/keel-db.sql.gz.partial"
  KEEL_BACKUP_FAILED=0
  if docker exec keel-postgres pg_dump -U keel -d keel 2>/dev/null | gzip > "$partial"; then
    # A pg_dump that fails mid-stream still exits 0 through the pipe, so verify the artifact.
    if ! gzip -t "$partial" 2>/dev/null; then
      echo "[$(date -Iseconds)] ERROR: keel-db.sql.gz is not a valid gzip archive"
      KEEL_BACKUP_FAILED=1
    elif [ "$(zcat "$partial" | grep -c '^COPY public')" -lt 5 ]; then
      echo "[$(date -Iseconds)] ERROR: keel-db.sql.gz has too few COPY blocks — dump is incomplete"
      KEEL_BACKUP_FAILED=1
    fi
  else
    echo "[$(date -Iseconds)] ERROR: keel-postgres pg_dump failed"
    KEEL_BACKUP_FAILED=1
  fi
  if [ "$KEEL_BACKUP_FAILED" -eq 0 ]; then
    mv -f "$partial" "$dump"
  else
    rm -f "$partial"
  fi

  # Publish freshness metadata only for a successfully verified KEEL dump. A failure
  # must retain the previous manifest and make this backup visibly degraded.
  if [ "$KEEL_BACKUP_FAILED" -eq 0 ]; then
    if ! node /opt/keel/ops/keel-dump-manifest.mjs "$dump"; then
      echo "[$(date -Iseconds)] ERROR: KEEL dump manifest could not be published"
      KEEL_BACKUP_FAILED=1
    fi
  fi

  # KEEL configuration and unit files (certificates excluded — they are mode 600 and
  # live outside the repo; they are re-issued, not restored from a stack backup).
  tar czf "$BACKUP_PATH/keel-config.tar.gz" \
    -C /opt/keel ops/ cli/ 2>/dev/null || true

  # KEEL and host unit files
  tar czf "$BACKUP_PATH/systemd-services.tar.gz" \
    /etc/systemd/system/keel-*.service /etc/systemd/system/keel-*.timer \
    /etc/systemd/system/claude-deployer.service /etc/systemd/system/claude-keel-operator.service \
    /etc/systemd/system/mimule-backup.service /etc/systemd/system/mimule-backup.timer \
    2>/dev/null || true

  rotate_dated_sets "$BACKUP_DIR" "$KEEP_DAILY"

  echo "[$(date -Iseconds)] Backup complete: $BACKUP_PATH"
  ls -lh "$BACKUP_PATH/"

  # Fail the unit if the DR store did not back up, so systemd surfaces it rather than
  # reporting a green run that protected nothing.
  if [ "${KEEL_BACKUP_FAILED:-0}" -ne 0 ]; then
    echo "[$(date -Iseconds)] BACKUP DEGRADED: KEEL database was not backed up"
    exit 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
