#!/usr/bin/env bash
# Wake the vps-deployer Claude session (claude-deployer.service, tmux socket "deployer") with one
# deploy event, typed into its prompt. Called by deploy.sh on real events only, never on idle ticks.
# Best-effort: deploys never depend on the agent, so this always exits 0. A session that is not
# running (both are off since vps-deployer was switched off) makes this a no-op.
# Usage: notify-agent.sh <event> <sha> <detail>
EVENT=$1 SHA=${2:0:7} DETAIL=${3:-}
T="tmux -L deployer"
K="/usr/sbin/runuser -u keelops -- /usr/bin/tmux -L keelops-deployer"
if $K has-session -t keelops-deployer 2>/dev/null; then  # keelops copy (check-and-report only)
  $K send-keys -t keelops-deployer -l "[keel-deploy] event=$EVENT sha=$SHA at $(date -u '+%F %T') UTC: ${DETAIL//$'\n'/ } -- handle per 'Deployer role' in CLAUDE.md." && sleep 1 && $K send-keys -t keelops-deployer Enter
fi
$T has-session -t deployer 2>/dev/null || exit 0
MSG="[keel-deploy] event=$EVENT sha=$SHA at $(date -u '+%F %T') UTC: ${DETAIL//$'\n'/ } -- handle per 'Deploy events' in CLAUDE.md."
$T send-keys -t deployer -l "$MSG" && sleep 1 && $T send-keys -t deployer Enter
exit 0
