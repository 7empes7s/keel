#!/usr/bin/env bash
# Wake the vps-deployer Claude session (claude-deployer.service, tmux socket "deployer") with one
# deploy event, typed into its prompt. Called by deploy.sh on real events only, never on idle ticks.
# Best-effort: deploys never depend on the agent, so this always exits 0.
# Usage: notify-agent.sh <event> <sha> <detail>
EVENT=$1 SHA=${2:0:7} DETAIL=${3:-}
LOG=/var/log/keel-deploy.log
T="tmux -L deployer"
if ! $T has-session -t deployer 2>/dev/null; then
  printf '%s %s\n' "$(date -u '+%F %T')" "WARN: vps-deployer not running; $EVENT ${SHA} not handed to the agent" >> "$LOG"
  exit 0
fi
MSG="[keel-deploy] event=$EVENT sha=$SHA at $(date -u '+%F %T') UTC: ${DETAIL//$'\n'/ } -- handle per 'Deploy events' in CLAUDE.md."
$T send-keys -t deployer -l "$MSG" && sleep 1 && $T send-keys -t deployer Enter
exit 0
