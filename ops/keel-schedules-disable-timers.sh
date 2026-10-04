#!/usr/bin/env bash
# Step 6: stop and disable only the old triggers, retaining every service unit.
# Timers whose unit file was never installed are skipped; `systemctl disable` fails on them.
set -euo pipefail
TIMERS=()
for timer in keel-backup-tier1.timer keel-backup-tier2.timer keel-backup-tier3.timer keel-offsite.timer keel-prune.timer; do
  if [ -n "$(systemctl list-unit-files --no-legend "$timer")" ]; then TIMERS+=("$timer"); fi
done
if [ "${#TIMERS[@]}" -gt 0 ]; then systemctl disable --now "${TIMERS[@]}"; fi
bash "$(dirname "$0")/keel-schedules-check-timers.sh"
