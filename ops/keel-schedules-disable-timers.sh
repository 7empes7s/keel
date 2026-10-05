#!/usr/bin/env bash
# Step 6: stop and disable only the old triggers, retaining every service unit.
#
#   bash ops/keel-schedules-disable-timers.sh [KIND,...]
#
# KIND,... is the list of kinds just seeded. keel-offsite.timer is retired only when offsite is in
# it (or no list is given): until offsite has a schedule row, that timer runs the daily copy.
# The per-tier backup timers and keel-prune.timer are always retired.
# Timers whose unit file was never installed are skipped; `systemctl disable` fails on them.
set -euo pipefail
KINDS="${1:-collect,prune,offsite}"
TIMERS=()
for timer in $(bash "$(dirname "$0")/keel-schedules-check-timers.sh" --list "$KINDS"); do
  if [ -n "$(systemctl list-unit-files --no-legend "$timer")" ]; then TIMERS+=("$timer"); fi
done
if [ "${#TIMERS[@]}" -gt 0 ]; then systemctl disable --now "${TIMERS[@]}"; fi
bash "$(dirname "$0")/keel-schedules-check-timers.sh" "$KINDS"
