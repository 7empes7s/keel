#!/usr/bin/env bash
# Host-state verification, deliberately not a mocked unit test.
set -euo pipefail
for timer in keel-backup-tier{1,2,3}.timer keel-offsite.timer keel-prune.timer; do
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
