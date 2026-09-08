#!/usr/bin/env bash
#
# Container entrypoint for the KEEL PowerShell collection plane (design §4.3).
#
# Contract: read ONE job descriptor and write ONE canonical JSON result to
# stdout. This is a job queue, not a per-resource shell-out — pwsh module
# load is slow enough that spawning a process per resource would destroy
# throughput, so the caller (engine/powershell/jobQueue.mjs) invokes this
# once per job and the job itself may cover many resources/cmdlets.
#
# Job descriptor (JSON), read from stdin by default, or from the file named
# by $KEEL_JOB_FILE if that env var is set (useful for a mounted-file
# invocation instead of piping stdin):
#
#   {
#     "adapter":  "powershell/probe",   // adapter id — reserved for future
#                                        // non-probe modes (collect/restore)
#     "mode":     "probe",              // only "probe" is implemented today
#     "workload": "exo,scc,defender,teams,spo"   // or "all", or a single name
#   }
#
# Only mode "probe" exists right now — it runs probe-workloads.ps1 and
# streams its JSON straight through to stdout. Diagnostics go to stderr so
# stdout stays pure JSON.

set -euo pipefail

if [[ -n "${KEEL_JOB_FILE:-}" ]]; then
  if [[ ! -f "$KEEL_JOB_FILE" ]]; then
    echo "run-job.sh: KEEL_JOB_FILE=$KEEL_JOB_FILE does not exist" >&2
    exit 2
  fi
  JOB_JSON="$(cat "$KEEL_JOB_FILE")"
else
  JOB_JSON="$(cat -)"
fi

if [[ -z "$JOB_JSON" ]]; then
  echo "run-job.sh: empty job descriptor (expected JSON on stdin or \$KEEL_JOB_FILE)" >&2
  exit 2
fi

export KEEL_JOB_JSON="$JOB_JSON"

exec pwsh -NoLogo -NoProfile -NonInteractive -Command '
  $ErrorActionPreference = "Stop"

  try {
    $job = $env:KEEL_JOB_JSON | ConvertFrom-Json
  } catch {
    [Console]::Error.WriteLine("run-job.sh: job descriptor is not valid JSON: $($_.Exception.Message)")
    exit 2
  }

  $mode = if ($job.mode) { $job.mode } else { "probe" }
  if ($mode -ne "probe") {
    [Console]::Error.WriteLine("run-job.sh: unsupported mode `"$mode`" (only `"probe`" is implemented)")
    exit 2
  }

  $workloadArg = if ($job.workload) { $job.workload } else { "all" }

  $tenantConfigPath = if ($job.tenantConfigPath) { $job.tenantConfigPath } else { "/etc/keel/tenant.json" }

  if ($workloadArg -eq "all") {
    & /app/probe-workloads.ps1 -TenantConfigPath $tenantConfigPath
  } else {
    $list = $workloadArg -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    & /app/probe-workloads.ps1 -TenantConfigPath $tenantConfigPath -Workloads $list
  }

  exit $LASTEXITCODE
'
