#Requires -Version 7.0
<#
.SYNOPSIS
  Delegated-only probe, cmdlet half: calls every Get- cmdlet a workload offers, app-only,
  and records which ones refuse an app (delegated access design, rows 14, 16, 17, 18).

.DESCRIPTION
  Connects app-only with the certificate in -TenantConfigPath (the Collector by default),
  lists the workload's Get- cmdlets, and calls each one that has a parameter set with no
  required parameter. Cmdlets that need a parameter are listed as needs-parameter and not
  called. Where a cmdlet takes -ResultSize, it is called with -ResultSize 1.

  READ-ONLY: only cmdlets with the verb Get are ever called. Output is a JSON array on
  stdout, one row per cmdlet: { workload, cmdlet, outcome, count, error, seconds }.
  outcome is works, refused, not-supported, not-found, needs-parameter or error.
  Nothing returned by a cmdlet is kept except the item count.

  Run it the way engine/powershell/jobQueue.mjs runs the other scripts:
    docker run --rm -i --memory 1g -v /etc/keel:/etc/keel:ro -v <clone>/ops/powershell:/app:ro \
      --entrypoint pwsh keel-powershell:latest -NoLogo -NoProfile -NonInteractive \
      -File /app/sweep-get-cmdlets.ps1 -Workload exo > sweep-exo.json
#>
[CmdletBinding()]
param(
    [string]$TenantConfigPath = '/etc/keel/tenant.json',
    [Parameter(Mandatory)][ValidateSet('exo', 'scc', 'teams', 'spo')][string]$Workload,
    [string]$OrgDomain,
    [string]$SpoAdminUrl
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$Common = [System.Management.Automation.PSCmdlet]::CommonParameters + [System.Management.Automation.PSCmdlet]::OptionalCommonParameters

function Write-Diag([string]$Message) { [Console]::Error.WriteLine("sweep-get-cmdlets: $Message") }

$rows = [System.Collections.Generic.List[object]]::new()
function Add-Row($Cmdlet, $Outcome, $Count, $ErrorText, $Seconds) {
    $rows.Add([ordered]@{ workload = $Workload; cmdlet = $Cmdlet; outcome = $Outcome; count = $Count; error = $ErrorText; seconds = $Seconds })
}

function Get-Outcome([string]$Text) {
    if ($Text -match 'access denied|accessdenied|not authori[sz]ed|unauthori[sz]ed|forbidden|insufficient|does not have (the )?(required )?permission|isn''t allowed|not allowed to|requires? (a )?(user|delegated)|role assignment') { return 'refused' }
    if ($Text -match 'not supported|unsupported|app-?only|application (permission|context)|is not available|isn''t available|not enabled for') { return 'not-supported' }
    if ($Text -match 'couldn''t be found|could not be found|not found|doesn''t exist|does not exist') { return 'not-found' }
    return 'error'
}

# A parameter set with no required parameter (common parameters aside) can be called bare.
function Test-CallableBare($Command) {
    foreach ($set in $Command.ParameterSets) {
        $required = @($set.Parameters | Where-Object { $_.IsMandatory -and $_.Name -notin $Common })
        if ($required.Count -eq 0) { return $true }
    }
    return $false
}

function Invoke-Sweep($Commands) {
    foreach ($command in ($Commands | Where-Object { $_.Verb -eq 'Get' } | Sort-Object Name -Unique)) {
        if (-not (Test-CallableBare $command)) { Add-Row $command.Name 'needs-parameter' $null $null 0; continue }
        $splat = @{ ErrorAction = 'Stop' }
        if ($command.Parameters.ContainsKey('ResultSize')) { $splat.ResultSize = 1 }
        $watch = [Diagnostics.Stopwatch]::StartNew()
        try {
            $out = & $command.Name @splat
            $count = if ($null -eq $out) { 0 } else { @($out).Count }
            Add-Row $command.Name 'works' $count $null ([math]::Round($watch.Elapsed.TotalSeconds, 1))
        } catch {
            $text = $_.Exception.Message
            Add-Row $command.Name (Get-Outcome $text) $null $text ([math]::Round($watch.Elapsed.TotalSeconds, 1))
        }
        Write-Diag "$($command.Name) -> $($rows[-1].outcome)"
    }
}

$config = Get-Content -Raw -Path $TenantConfigPath | ConvertFrom-Json
$raw = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
$pfxPassword = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($raw.Export('Pkcs12', $pfxPassword), $pfxPassword, $flags)

# The tenant's domain and SharePoint admin site, read from Graph with the same app (never guessed).
if ((-not $OrgDomain -and $Workload -in 'exo', 'scc', 'spo') -or (-not $SpoAdminUrl -and $Workload -eq 'spo')) {
    $b64 = { param($b) [Convert]::ToBase64String($b).Replace('+', '-').Replace('/', '_').TrimEnd('=') }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = & $b64 ([Text.Encoding]::UTF8.GetBytes((@{ alg = 'RS256'; typ = 'JWT'; x5t = (& $b64 $cert.GetCertHash()) } | ConvertTo-Json -Compress)))
    $payload = & $b64 ([Text.Encoding]::UTF8.GetBytes((@{ aud = "https://login.microsoftonline.com/$($config.tenantId)/oauth2/v2.0/token"; iss = $config.clientId; sub = $config.clientId; jti = [guid]::NewGuid().ToString(); nbf = $now - 60; exp = $now + 540 } | ConvertTo-Json -Compress)))
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    $sig = & $b64 ($rsa.SignData([Text.Encoding]::UTF8.GetBytes("$header.$payload"), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1))
    $token = (Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$($config.tenantId)/oauth2/v2.0/token" -ContentType 'application/x-www-form-urlencoded' -Body @{
            client_id = $config.clientId; scope = 'https://graph.microsoft.com/.default'; grant_type = 'client_credentials'
            client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'; client_assertion = "$header.$payload.$sig" }).access_token
    $headers = @{ Authorization = "Bearer $token" }
    if (-not $OrgDomain) {
        $org = Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/organization' -Headers $headers
        $OrgDomain = ($org.value[0].verifiedDomains | Where-Object { $_.isInitial } | Select-Object -First 1).name
    }
    if ($Workload -eq 'spo' -and -not $SpoAdminUrl) {
        $root = Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/sites/root' -Headers $headers
        $SpoAdminUrl = "https://$(([Uri]$root.webUrl).Host.Split('.')[0])-admin.sharepoint.com"
    }
    $token = $null; $headers = $null
}

try {
    switch ($Workload) {
        'exo' {
            Import-Module ExchangeOnlineManagement | Out-Null
            $before = @(Get-Module | ForEach-Object Name)
            Connect-ExchangeOnline -AppId $config.clientId -Organization $OrgDomain -Certificate $cert -ShowBanner:$false -ShowProgress:$false | Out-Null
            $modules = @(Get-Module | Where-Object { $_.Name -notin $before } | ForEach-Object Name) + 'ExchangeOnlineManagement'
            Invoke-Sweep (Get-Command -Module $modules -Verb Get)
        }
        'scc' {
            Import-Module ExchangeOnlineManagement | Out-Null
            $before = @(Get-Module | ForEach-Object Name)
            Connect-IPPSSession -AppId $config.clientId -Organization $OrgDomain -Certificate $cert -ShowBanner:$false | Out-Null
            $modules = @(Get-Module | Where-Object { $_.Name -notin $before } | ForEach-Object Name)
            Invoke-Sweep (Get-Command -Module $modules -Verb Get)
        }
        'teams' {
            Import-Module MicrosoftTeams | Out-Null
            Connect-MicrosoftTeams -Certificate $cert -ApplicationId $config.clientId -TenantId $config.tenantId | Out-Null
            Invoke-Sweep (Get-Command -Module MicrosoftTeams -Verb Get)
        }
        'spo' {
            # Only the reads section 4 asks about: search schema and term store, plus tenant settings as a control.
            Import-Module PnP.PowerShell | Out-Null
            # PnP has crashed this image's pwsh before (see probe-workloads.ps1); this script runs one
            # workload per process, so a crash loses only these rows. Report an empty output as that.
            Connect-PnPOnline -Url $SpoAdminUrl -ClientId $config.clientId -Tenant $OrgDomain `
                -CertificateBase64Encoded ([Convert]::ToBase64String($cert.Export('Pkcs12', $pfxPassword))) `
                -CertificatePassword (ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force) | Out-Null
            foreach ($probe in @(
                    @{ Name = 'Get-PnPSearchConfiguration -Scope Subscription'; Block = { Get-PnPSearchConfiguration -Scope Subscription } },
                    @{ Name = 'Get-PnPTermGroup'; Block = { Get-PnPTermGroup } },
                    @{ Name = 'Get-PnPTenant'; Block = { Get-PnPTenant } })) {
                $watch = [Diagnostics.Stopwatch]::StartNew()
                try {
                    $out = & $probe.Block
                    Add-Row $probe.Name 'works' $(if ($null -eq $out) { 0 } else { @($out).Count }) $null ([math]::Round($watch.Elapsed.TotalSeconds, 1))
                } catch {
                    Add-Row $probe.Name (Get-Outcome $_.Exception.Message) $null $_.Exception.Message ([math]::Round($watch.Elapsed.TotalSeconds, 1))
                }
            }
        }
    }
} catch {
    Add-Row $null 'not-connected' $null $_.Exception.Message 0
} finally {
    try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Disconnect-MicrosoftTeams -ErrorAction SilentlyContinue | Out-Null } catch {}
}

ConvertTo-Json -InputObject @($rows) -Depth 4
