#!/usr/bin/env bash
# Host-state verification, deliberately not a mocked unit test.
#
#   bash ops/keel-schedules-check-timers.sh [KIND,...]          # check the old timers are off
#   bash ops/keel-schedules-check-timers.sh --list [KIND,...]   # print those timers only
#
# The per-tier backup timers and keel-prune.timer are always expected off. keel-offsite.timer is
# expected off only when offsite is in the list (or no list is given), because until offsite has
# a schedule row that timer is the only thing running the daily copy. A timer whose unit file
# was never installed passes: it cannot fire either.
set -euo pipefail
LIST=""
if [ "${1:-}" = "--list" ]; then LIST=1; shift; fi
KINDS="${1:-collect,prune,offsite}"
TIMERS=(keel-backup-tier1.timer keel-backup-tier2.timer keel-backup-tier3.timer keel-prune.timer)
case ",$KINDS," in *,offsite,*) TIMERS+=(keel-offsite.timer) ;; esac
if [ -n "$LIST" ]; then printf '%s\n' "${TIMERS[@]}"; exit 0; fi
for timer in "${TIMERS[@]}"; do
  if [ -z "$(systemctl list-unit-files --no-legend "$timer")" ]; then
    echo "PASS: $timer not installed"
    continue
  fi
  enabled=$(systemctl is-enabled "$timer") || status=$?
  if [ "${status:-0}" -ne 1 ] || [ "$enabled" != disabled ]; then
    echo "FAIL: $timer is $enabled (expected disabled)" >&2
    exit 1
  fi
  active=$(systemctl is-active "$timer") || status=$?
  if [ "$active" != inactive ]; then
    echo "FAIL: $timer is $active (expected inactive)" >&2
    exit 1
  fi
  echo "PASS: $timer disabled and inactive"
  unset status
done
