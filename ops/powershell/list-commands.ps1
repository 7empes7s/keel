#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL PowerShell plane: list the Get cmdlets one module offers (discovery).

.DESCRIPTION
  Reads the job descriptor from $env:KEEL_JOB_JSON:
    { mode: "commands", session: "exo" | "ipps" | "teams" | "pnp", tenantConfigPath? }
  Answers one JSON envelope on stdout:
    { ok: true,  module, session, commands: ["Get-...", ...] }   exit 0
    { ok: false, session, error: { message, errorId } }          exit 1

  Cmdlets are listed, never run. Exchange Online and Security & Compliance build their
  cmdlets when a session connects (and only those the app's roles allow), so "exo" and
  "ipps" connect with the collector certificate, list, and disconnect. MicrosoftTeams
  and PnP.PowerShell ship their cmdlets in the module, so those are only imported.
  Nothing here writes to the tenant.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Out-Envelope {
    param([hashtable]$Envelope, [int]$Code)
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Envelope -Depth 4 -Compress))
    exit $Code
}

try {
    $job = $env:KEEL_JOB_JSON | ConvertFrom-Json -AsHashtable
} catch {
    Out-Envelope -Envelope @{ ok = $false; session = $null; error = @{ message = "job descriptor is not valid JSON: $($_.Exception.Message)"; errorId = 'BadDescriptor' } } -Code 1
}

$session = [string]$job['session']
$modules = @{ exo = 'ExchangeOnlineManagement'; ipps = 'ExchangeOnlineManagement'; teams = 'MicrosoftTeams'; pnp = 'PnP.PowerShell' }
if (-not $modules.ContainsKey($session)) {
    Out-Envelope -Envelope @{ ok = $false; session = $session; error = @{ message = "session $session is not one of exo, ipps, teams, pnp"; errorId = 'SessionNotAllowed' } } -Code 1
}
$module = $modules[$session]
$tenantConfigPath = if ($job['tenantConfigPath']) { [string]$job['tenantConfigPath'] } else { '/etc/keel/tenant.json' }

$step = 'import'
try {
    # PnP is never loaded beside ExchangeOnlineManagement (see probe-workloads.ps1).
    Import-Module $module -ErrorAction Stop | Out-Null
    if ($session -eq 'teams' -or $session -eq 'pnp') {
        $names = @((Get-Module $module).ExportedCommands.Keys)
    } else {
        $step = 'connect'
        $config = Get-Content -Raw -Path $tenantConfigPath | ConvertFrom-Json
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
        if ($session -eq 'ipps') {
            Connect-IPPSSession -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false | Out-Null
        } else {
            Connect-ExchangeOnline -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false -ShowProgress:$false | Out-Null
        }
        $step = 'list'
        # The connection imports a temporary module (tmpEXO_...) that holds the cmdlets.
        $sources = @($module) + @(Get-ConnectionInformation | ForEach-Object { $_.ModuleName } | Where-Object { $_ })
        $names = @(Get-Command -Verb Get -ErrorAction SilentlyContinue |
            Where-Object { $sources -contains $_.Source -or $_.Source -like 'tmpEXO_*' -or $_.Source -like 'tmp_*' } |
            ForEach-Object { $_.Name })
    }
    $commands = @($names | Where-Object { $_ -match '^Get-[A-Za-z0-9]+$' } | Sort-Object -Unique)
    if (-not $commands.Count) { throw "the module listed no Get cmdlets" }
    Out-Envelope -Envelope @{ ok = $true; module = $module; session = $session; commands = $commands } -Code 0
} catch {
    $verb = @{ import = 'could not load the module'; connect = 'could not connect'; list = 'could not list the cmdlets' }[$step]
    Out-Envelope -Envelope @{ ok = $false; session = $session; error = @{ message = "${verb}: $($_.Exception.Message)"; errorId = "List$((Get-Culture).TextInfo.ToTitleCase($step))Failed" } } -Code 1
} finally {
    if ($session -eq 'exo' -or $session -eq 'ipps') { try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }
}
