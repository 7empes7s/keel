# KEEL PowerShell collection plane (design §4.3).
#
# A memory-capped container that hosts the three PowerShell surfaces the
# graph-native adapters cannot reach: Exchange Online / Security & Compliance,
# Microsoft Teams, and SharePoint Online (PnP). Microsoft365DSC is
# deliberately NOT installed here — it is a separate, much larger profile
# (design §4.3 "DSC loads as a separate profile"), for a later phase.
#
# Runtime contract: engine/powershell/jobQueue.mjs invokes this image with a
# hard `docker run --memory` cap and mounts /etc/keel read-only for
# credentials. See ops/powershell/run-job.sh for the entrypoint contract.

FROM mcr.microsoft.com/powershell:7.4-ubuntu-22.04

ENV POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    PSGALLERY_TIMEOUT_SEC=600

# Install only the modules the probe and future collect/restore adapters need.
# -Scope AllUsers puts them on the default PSModulePath so no manual
# PSModulePath wiring is needed at runtime.
#
# Deliberately NOT calling Install-PackageProvider -Name NuGet: the base
# image already ships PackageManagement's NuGet provider (verified: v3.0.0.1,
# satisfies PowerShellGet's >=2.8.5.201 floor), and forcing an online
# provider-bootstrap lookup here failed ("No match was found for the
# specified search criteria for the provider 'NuGet'") while still leaving
# the RUN step's exit code 0 — a silent no-op build that skipped every
# Install-Module call beneath it. Confirmed by content size: the broken image
# was byte-for-byte the same size as the bare base image.
# MicrosoftTeams is pinned: an unpinned rebuild on 2026-10-05 pulled 8.0.0, a major
# version Teams capture has not been tested on. Bump it on purpose, with a live check.
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command " \
      \$ErrorActionPreference = 'Stop'; \
      Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
      Install-Module -Name ExchangeOnlineManagement -MinimumVersion 3.0.0 -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Install-Module -Name MicrosoftTeams -RequiredVersion 7.9.0 -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Install-Module -Name PnP.PowerShell -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Write-Host 'module install complete:'; \
      Get-Module -ListAvailable ExchangeOnlineManagement,MicrosoftTeams,PnP.PowerShell | Select-Object Name,Version | Format-Table -AutoSize | Out-String | Write-Host; \
    " \
    && rm -rf /tmp/* /root/.cache /root/.local/share/powershell/CommandAnalysisCache 2>/dev/null || true

WORKDIR /app
COPY run-job.sh /app/run-job.sh
COPY probe-workloads.ps1 /app/probe-workloads.ps1
COPY run-cmdlet.ps1 /app/run-cmdlet.ps1
RUN chmod +x /app/run-job.sh

# No credentials baked in — /etc/keel is bind-mounted read-only at `docker run`
# time by jobQueue.mjs. Read-only probing only; this image never writes to a
# tenant.
ENTRYPOINT ["/app/run-job.sh"]
