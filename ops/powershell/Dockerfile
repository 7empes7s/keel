# KEEL PowerShell collection plane (design §4.3).
#
# A memory-capped container that hosts the three PowerShell surfaces the
# graph-native adapters cannot reach: Exchange Online / Security & Compliance,
# Microsoft Teams, and SharePoint Online (PnP). Microsoft365DSC is
# deliberately NOT installed here — it is a separate, much larger profile
# (design §4.3 "DSC loads as a separate profile"), for a later phase.
#
# Runtime contract: engine/powershell/jobQueue.mjs invokes this image with a
# hard `docker run --memory` cap, as a non-root user on a read-only root
# filesystem, and mounts only the job's own connection settings, certificate
# and key (never all of /etc/keel). See ops/powershell/run-job.sh for the
# entrypoint contract.

# The base image is pinned by digest, not only by tag, so a rebuild cannot pull a
# different image under the same name (security audit run 2, finding 8). To move
# it, pull the new tag, read its digest with
# `docker image inspect --format '{{index .RepoDigests 0}}' <tag>`, and update both.
FROM mcr.microsoft.com/powershell:7.4-ubuntu-22.04@sha256:62300a213a9293916333df2b014cd3a8f22fb0b0b65f2bb446aaf436bcf8c868

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
# ExchangeOnlineManagement is pinned to 3.10.1, the version the Exchange and Purview
# live captures were taken at (#339); a floor alone let a rebuild change it.
# PnP.PowerShell is pinned to 3.4.1, the version the OneDrive live capture was taken at,
# so the SharePoint per-site sharing read capture records the version the image runs.
# Only the clean-up may fail quietly: a trailing `|| true` once covered the whole step,
# so a failed module install still built an image without the modules.
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command " \
      \$ErrorActionPreference = 'Stop'; \
      Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; \
      Install-Module -Name ExchangeOnlineManagement -RequiredVersion 3.10.1 -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Install-Module -Name MicrosoftTeams -RequiredVersion 7.9.0 -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Install-Module -Name PnP.PowerShell -RequiredVersion 3.4.1 -Scope AllUsers -Force -AllowClobber -Repository PSGallery; \
      Write-Host 'module install complete:'; \
      Get-Module -ListAvailable ExchangeOnlineManagement,MicrosoftTeams,PnP.PowerShell | Select-Object Name,Version | Format-Table -AutoSize | Out-String | Write-Host; \
    " \
    && (rm -rf /tmp/* /root/.cache /root/.local/share/powershell/CommandAnalysisCache 2>/dev/null || true)

# jobQueue.mjs mounts the deployed ops/powershell read-only over /app, so these
# copies are used only when the image is run by hand; the allowlist a job sees is
# always the deployed one (#339).
WORKDIR /app
COPY run-job.sh /app/run-job.sh
COPY probe-workloads.ps1 /app/probe-workloads.ps1
COPY run-cmdlet.ps1 /app/run-cmdlet.ps1
COPY keel-json.ps1 /app/keel-json.ps1
COPY list-commands.ps1 /app/list-commands.ps1
RUN chmod +x /app/run-job.sh

# No credentials baked in: at `docker run` time jobQueue.mjs mounts a read-only
# copy of the job's own settings, certificate and key at /run/keel-job.
ENTRYPOINT ["/app/run-job.sh"]
