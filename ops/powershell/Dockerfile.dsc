# KEEL DSC profile (design §4.3 "DSC loads as a separate profile"): the keel-dsc image.
#
# Microsoft365DSC drives about 270 Microsoft 365 setting types through one resource each.
# KEEL uses it only as a writer for settings it has no other way to put back, one
# allowlisted resource call at a time (ops/powershell/run-dsc.ps1), never a whole
# configuration. The first resource is EXODistributionGroup (distribution lists).
#
# Kept apart from keel-powershell because it is much larger: 370 MB of modules and
# about 1 GB of memory at peak (probe Q182, 2026-10-28: 951 MB for 7 calls). The job
# queue runs it with its own memory cap (engine/powershell/dscJob.mjs, DSC_MEMORY).
#
# Build on the server, next to keel-powershell:
#   docker build -t keel-dsc:latest -f ops/powershell/Dockerfile.dsc ops/powershell
#
# Microsoft365DSC 2.x asks for PowerShell 7.6 and prints a warning on 7.5. MCR has no
# 7.6 image yet (Q182: "not found"), and the Q182 writer check passed on this 7.5 image.
# Move to a 7.6 tag once Microsoft publishes one, with a new live capture.
FROM mcr.microsoft.com/powershell:7.5-ubuntu-24.04

ENV POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    PSGALLERY_TIMEOUT_SEC=900 \
    M365DSCTelemetryEnabled=False

# Pinned on purpose: a write proof is bound to this version (run-dsc.ps1 refuses a job
# that asks for another). Update-M365DSCDependencies installs the exact dependency
# versions this Microsoft365DSC release declares. Telemetry is off through its
# environment variable (Set-M365DSCTelemetryOption writes a machine variable, Windows only).
# The same NuGet note as ops/powershell/Dockerfile applies: no Install-PackageProvider.
# The clean-up is grouped so a failed install fails the build instead of being masked.
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command " \
      \$ErrorActionPreference = 'Stop'; \
      Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
      Install-Module -Name Microsoft365DSC -RequiredVersion 2.26.1021.1 -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Install-Module -Name PSDesiredStateConfiguration -RequiredVersion 2.0.7 -Scope AllUsers -Force -Repository PSGallery; \
      Import-Module Microsoft365DSC -RequiredVersion 2.26.1021.1 -Force; \
      Update-M365DSCDependencies -Scope AllUsers | Out-Null; \
      Write-Host 'module install complete:'; \
      Get-Module -ListAvailable Microsoft365DSC,PSDesiredStateConfiguration | Select-Object Name,Version | Format-Table -AutoSize | Out-String | Write-Host; \
    " \
    && (rm -rf /tmp/* /root/.cache /root/.local/share/powershell/CommandAnalysisCache 2>/dev/null || true)

# The job queue mounts the deployed ops/powershell read-only over /app, so the allowlist
# a job sees is always the deployed one; these copies are for running the image by hand.
WORKDIR /app
COPY run-job.sh /app/run-job.sh
COPY run-dsc.ps1 /app/run-dsc.ps1
RUN chmod +x /app/run-job.sh

# No credentials baked in: /etc/keel is bind-mounted read-only at `docker run` time.
ENTRYPOINT ["/app/run-job.sh"]
