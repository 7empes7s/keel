#!/usr/bin/env bash
# Step 6: stop and disable only the old triggers, retaining every service unit.
set -euo pipefail
TIMERS=(keel-backup-tier1.timer keel-backup-tier2.timer keel-backup-tier3.timer keel-offsite.timer keel-prune.timer)
systemctl disable --now "${TIMERS[@]}"
bash "$(dirname "$0")/keel-schedules-check-timers.sh"
