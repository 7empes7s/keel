#!/usr/bin/env bash
# Installs scheduled collection on the host: keel-worker runs queued jobs, keel-scheduler
# turns schedule rows into jobs every five minutes (issue #91).
#
#   bash ops/keel-schedules-install.sh --root /opt/keel-live [--tenant-config /etc/keel/tenant.json] [--kinds collect]
#
# --root is the deployed tree the units run from; the unit files say /opt/keel, and are
# installed with that prefix replaced. --kinds is passed to keel-schedules-migrate.mjs and
# defaults to collect, so tier 1/2/3 collection is scheduled while prune and offsite stay
# off. The old per-tier timers are left disabled: the schedule rows replace them.
#
# It stops before changing anything if the preflight finds work a new worker would pick up.
# Then run `node cli/keel-schedules-host.mjs run-now` and, once the jobs finish, `health`.
set -euo pipefail

ROOT=""
TENANT_CONFIG=/etc/keel/tenant.json
KINDS=collect
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --tenant-config) TENANT_CONFIG="$2"; shift 2 ;;
    --kinds) KINDS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ROOT" ] || { echo "--root is required" >&2; exit 2; }
ROOT="$(cd "$ROOT" && pwd -P)"
for f in cli/keel-worker.mjs cli/keel-scheduler.mjs cli/keel-schedules-migrate.mjs cli/keel-schedules-host.mjs; do
  [ -f "$ROOT/$f" ] || { echo "missing $ROOT/$f" >&2; exit 1; }
done
[ -f /etc/keel/db.env ] || { echo "missing /etc/keel/db.env" >&2; exit 1; }
[ -f "$TENANT_CONFIG" ] || { echo "missing $TENANT_CONFIG" >&2; exit 1; }

set -a; . /etc/keel/db.env; set +a
node "$ROOT/cli/keel-schedules-host.mjs" preflight --tenant-config "$TENANT_CONFIG"

UNITS=(keel-worker.service keel-scheduler.service keel-scheduler.timer)
for unit in "${UNITS[@]}"; do
  sed "s#/opt/keel/#$ROOT/#g; s#^WorkingDirectory=/opt/keel\$#WorkingDirectory=$ROOT#" \
    "$ROOT/ops/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
systemctl daemon-reload

TENANT_REF="$(cd "$ROOT" && node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  import { tenantRefFor } from './engine/store/tenantRef.mjs';
  console.log(tenantRefFor(JSON.parse(readFileSync(process.argv[1], 'utf8')).tenantId));
" "$TENANT_CONFIG")"
node "$ROOT/cli/keel-schedules-migrate.mjs" --tenant-ref "$TENANT_REF" --kinds "$KINDS"

systemctl enable --now keel-worker.service keel-scheduler.timer
systemctl is-active keel-worker.service keel-scheduler.timer
echo "installed from $ROOT for $TENANT_REF (kinds: $KINDS)"
