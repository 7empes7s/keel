#!/usr/bin/env bash
# Database watchdog (#1010), run every minute by keel-db-watchdog.timer. No AI.
#
# On 2026-11-04 Docker's port forward for keel-postgres (127.0.0.1:5433 -> 5432) died while
# Postgres kept running, and every connection was refused for 16 hours before anyone noticed
# (#1005). This opens a real connection each minute (cli/keel-db-watchdog.mjs probe, with
# KEEL_DB_URL from /etc/keel/db.env through the unit). After 2 failed checks in a row:
#   - container running (so the port is dead): docker restart -t 30 keel-postgres, then
#     systemctl restart keel-portal;
#   - container stopped: docker start keel-postgres, then systemctl restart keel-portal;
#   - no container, or already 3 restarts in the last hour: stop trying and alert, until the
#     database answers again.
# Every action goes to journald (stdout) and to /opt/ai-vault/daily/<date>.md. Alerts go through
# Keel's notification channels once the database answers; until then they wait in the state
# directory. Containers and units are acted on by name only, never by process pattern.
#
#   bash ops/keel-db-watchdog.sh                  # one check (what the timer runs)
#   source ops/keel-db-watchdog.sh; decide ...    # the decision alone, for tests
set -uo pipefail

STATE="${KEEL_DB_WATCHDOG_STATE:-${STATE_DIRECTORY:-/var/lib/keel-db-watchdog}}"
LIVE="${KEEL_LIVE:-/opt/keel-live}"
VAULT="${KEEL_VAULT_DIR:-/opt/ai-vault/daily}"
CONTAINER=keel-postgres
UNIT=keel-portal
FAILURES_TO_ACT=2
MAX_RESTARTS_PER_HOUR=3

# decide PROBE FAILURES CONTAINER RESTARTS_LAST_HOUR GAVE_UP
#   PROBE ok|fail; FAILURES failed checks in a row, this one included; CONTAINER the docker
#   state (running, exited, restarting, missing, ...); RESTARTS_LAST_HOUR actions taken in the
#   last hour; GAVE_UP yes|no. Prints one of: none, wait, restart, start, give-up.
decide() {
  local probe=$1 failures=$2 container=$3 restarts=$4 gave_up=$5
  if [ "$probe" = ok ]; then echo none; return; fi
  if [ "$gave_up" = yes ]; then echo none; return; fi
  if [ "$failures" -lt "$FAILURES_TO_ACT" ]; then echo wait; return; fi
  case "$container" in
    restarting) echo wait; return ;;   # docker is already bringing it back
    missing) echo give-up; return ;;   # nothing to start: a person has to look
  esac
  if [ "$restarts" -ge "$MAX_RESTARTS_PER_HOUR" ]; then echo give-up; return; fi
  if [ "$container" = running ]; then echo restart; else echo start; fi
}

now() { echo "${KEEL_WATCHDOG_NOW:-$(date -u +%s)}"; }

log() {
  local stamp
  stamp="$(date -u -d "@$(now)" '+%Y-%m-%d %H:%M')"
  echo "keel-db-watchdog: $*"
  if [ -d "$VAULT" ]; then
    printf -- '- %s UTC keel-db-watchdog: %s\n' "$stamp" "$*" >> "$VAULT/${stamp%% *}.md" || true
  fi
}

probe() { timeout 30 node "$LIVE/cli/keel-db-watchdog.mjs" probe 2>&1; }

container_state() { docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing; }

# Actions taken in the last hour, one epoch second per line; older lines are dropped.
restarts_last_hour() {
  local cutoff=$(( $(now) - 3600 )) line kept=()
  [ -f "$STATE/restarts" ] || { echo 0; return; }
  while read -r line; do [ -n "$line" ] && [ "$line" -gt "$cutoff" ] && kept+=("$line"); done < "$STATE/restarts"
  printf '%s\n' "${kept[@]+"${kept[@]}"}" | grep . > "$STATE/restarts.tmp"
  mv "$STATE/restarts.tmp" "$STATE/restarts"
  echo "${#kept[@]}"
}

# queue_alert ACTION DETAIL: kept until Keel's channels have it (the database must answer).
queue_alert() {
  mkdir -p "$STATE/alerts"
  printf '%s\n%s\n' "$1" "$2" > "$STATE/alerts/$(now)-$1"
}

send_alerts() {
  local file name action detail at out
  for file in "$STATE"/alerts/*; do
    [ -f "$file" ] || continue
    { read -r action; read -r detail; } < "$file"
    name="${file##*/}"
    at="$(date -u -d "@${name%%-*}" +%FT%TZ)"
    if out="$(timeout 30 node "$LIVE/cli/keel-db-watchdog.mjs" alert --action "$action" --at "$at" --detail "$detail" 2>&1)"; then
      log "alert ($action): $out"
      rm -f "$file"
    else
      log "alert ($action) not sent yet, will retry: $out"
    fi
  done
}

act() {  # restart|start
  local verb=$1
  echo "$(now)" >> "$STATE/restarts"
  echo 0 > "$STATE/failures"
  if [ "$verb" = restart ]; then
    log "database unreachable on 2 checks in a row with $CONTAINER running: restarting $CONTAINER, then $UNIT"
    docker restart -t 30 "$CONTAINER" || log "docker restart $CONTAINER failed"
    queue_alert restarted "Restarted $CONTAINER and $UNIT."
  else
    log "database unreachable and $CONTAINER is stopped: starting $CONTAINER, then restarting $UNIT"
    docker start "$CONTAINER" || log "docker start $CONTAINER failed"
    queue_alert started "Started $CONTAINER and restarted $UNIT."
  fi
  systemctl restart "$UNIT" || log "systemctl restart $UNIT failed"
}

main() {
  mkdir -p "$STATE"
  local failures=0 gave_up=no result probe_out container restarts action
  [ -f "$STATE/failures" ] && failures="$(cat "$STATE/failures")"
  [ -f "$STATE/gave-up" ] && gave_up=yes

  if probe_out="$(probe)"; then result=ok; else result=fail; fi
  if [ "$result" = ok ]; then
    if [ -f "$STATE/down-since" ]; then
      log "database answers again (first failed check $(date -u -d "@$(cat "$STATE/down-since")" '+%Y-%m-%d %H:%M') UTC)"
    fi
    echo 0 > "$STATE/failures"
    rm -f "$STATE/gave-up" "$STATE/down-since"
    send_alerts
    return 0
  fi

  failures=$((failures + 1))
  [ -f "$STATE/down-since" ] || now > "$STATE/down-since"
  echo "$failures" > "$STATE/failures"
  container="$(container_state)"
  restarts="$(restarts_last_hour)"
  action="$(decide "$result" "$failures" "$container" "$restarts" "$gave_up")"
  case "$action" in
    wait) log "database check failed ($failures in a row, $CONTAINER $container): ${probe_out:-no answer}" ;;
    restart|start) act "$action" ;;
    give-up)
      touch "$STATE/gave-up"
      log "GAVE UP: database still unreachable ($CONTAINER $container, $restarts restarts in the last hour); needs a person"
      queue_alert gave-up "$CONTAINER is $container after $restarts restarts in the last hour."
      ;;
  esac
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
