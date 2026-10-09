#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL PowerShell collection plane — workload connectivity probe (design §4.3 / §4.4).

.DESCRIPTION
  This is the empirical answer to "which M365 workloads can actually be reached with
  the credentials we hold," measured rather than assumed from documentation.

  For each requested workload, attempts an app-only certificate connection using the
  COLLECTOR credential (read path — /etc/keel/tenant.json by default), then one or
  more representative READ-ONLY cmdlet calls. Emits a flat JSON array to stdout:

    [ { workload, connected, cmdlet, ok, count, error,
        module, moduleVersion, capturedAt, synthetic }, ... ]

  Roadmap task-101: every row also records the PowerShell module and version it ran
  under, when it was captured, and synthetic = false (a real tenant read). Proof is
  bound to that version; tools/qualification/workloads.mjs --capture reads this output.

  One row per (workload, cmdlet) attempt, plus one workload-level row recording the
  connection result itself (cmdlet = $null). A connection failure produces exactly one
  row for that workload with connected=false and the real error text — the dependent
  cmdlets are never attempted, so they never appear.

  This script is READ-ONLY. It writes nothing to the tenant. All diagnostic/progress
  output goes to stderr; stdout carries only the final JSON.

.PARAMETER TenantConfigPath
  Path to the credential descriptor (tenantId/clientId/certPath/keyPath JSON). Defaults
  to the COLLECTOR credential, which is the read path this probe is scoped to use.

.PARAMETER Workloads
  Which workloads to probe. Defaults to all five.

.PARAMETER OrgDomain
  Override for the tenant's initial .onmicrosoft.com domain (needed by EXO/SCC/PnP).
  If not supplied, it is derived empirically from the tenant via Microsoft Graph
  (GET /organization) using the same COLLECTOR credential — never hardcoded.

.PARAMETER SpoAdminUrl
  Override for the SharePoint admin site URL. If not supplied, it is derived from the
  tenant's SharePoint root site (GET /sites/root via Graph).
#>
[CmdletBinding()]
param(
    [string]$TenantConfigPath = '/etc/keel/tenant.json',

    [ValidateSet('exo', 'scc', 'defender', 'teams', 'spo')]
    [string[]]$Workloads = @('exo', 'scc', 'defender', 'teams', 'spo'),

    [string]$OrgDomain,
    [string]$SpoAdminUrl
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

function Write-Diag {
    param([string]$Message)
    [Console]::Error.WriteLine("probe-workloads: $Message")
}

$results = [System.Collections.Generic.List[object]]::new()
$capturedAt = (Get-Date).ToUniversalTime().ToString('o')

function Add-Result {
    param(
        [Parameter(Mandatory)][string]$Workload,
        [Parameter(Mandatory)][bool]$Connected,
        [AllowNull()]$Cmdlet,
        [Parameter(Mandatory)][bool]$Ok,
        [AllowNull()]$Count,
        [AllowNull()]$ErrorText
    )
    $results.Add([ordered]@{
            workload  = $Workload
            connected = $Connected
            cmdlet    = $Cmdlet
            ok        = $Ok
            count     = $Count
            error     = $ErrorText
        })
}

function ConvertTo-Base64Url {
    param([byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

# --- Build an in-memory X509Certificate2 from the mounted PEM cert+key. ---
# CreateFromPemFile's key is re-imported as a PKCS12 blob because the raw
# ephemeral key set it produces does not survive correctly across every .NET
# crypto provider on Linux — a documented gotcha for app-only auth in
# containers. Nothing here is written to disk.
function Get-KeelCertificate {
    param([string]$CertPath, [string]$KeyPath)

    if (-not (Test-Path $CertPath)) { throw "certificate file not found: $CertPath" }
    if (-not (Test-Path $KeyPath)) { throw "key file not found: $KeyPath" }

    $raw = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($CertPath, $KeyPath)
    $pfxPassword = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    $pfxBytes = $raw.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $pfxPassword)
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor `
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxBytes, $pfxPassword, $flags)

    [PSCustomObject]@{
        Certificate = $cert
        PfxBase64   = [Convert]::ToBase64String($pfxBytes)
        PfxPassword = $pfxPassword
    }
}

# --- Hand-rolled client-credentials + certificate JWT assertion for Graph. ---
# Mirrors tools/tenant-probe/auth.mjs so both surfaces authenticate identically.
# Used ONLY to derive the tenant's own domain/site names below — never to
# write anything.
function Get-KeelGraphToken {
    param(
        [string]$TenantId,
        [string]$ClientId,
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )

    $now = [DateTimeOffset]::UtcNow
    $header = [ordered]@{
        alg = 'RS256'
        typ = 'JWT'
        x5t = ConvertTo-Base64Url $Certificate.GetCertHash()
    }
    $payload = [ordered]@{
        aud = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
        iss = $ClientId
        sub = $ClientId
        jti = [guid]::NewGuid().ToString()
        nbf = $now.ToUnixTimeSeconds() - 60
        exp = $now.ToUnixTimeSeconds() + 540
    }

    $headerB64 = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($header | ConvertTo-Json -Compress)))
    $payloadB64 = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress)))
    $signingInput = "$headerB64.$payloadB64"

    # Called as a static extension-method invocation rather than
    # $Certificate.GetRSAPrivateKey() — PowerShell's instance-method
    # resolution did not pick up this .NET extension method in this
    # container image (measured: "does not contain a method named
    # 'GetRSAPrivateKey'"), while the static form always resolves.
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
    $sigBytes = $rsa.SignData(
        [Text.Encoding]::UTF8.GetBytes($signingInput),
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $clientAssertion = "$signingInput.$(ConvertTo-Base64Url $sigBytes)"

    $body = @{
        client_id             = $ClientId
        scope                 = 'https://graph.microsoft.com/.default'
        client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        client_assertion      = $clientAssertion
        grant_type             = 'client_credentials'
    }

    $resp = Invoke-RestMethod -Method Post `
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -Body $body -ContentType 'application/x-www-form-urlencoded'
    return $resp.access_token
}

# A workload gets a single meaningful result row explaining why it was never
# attempted, rather than being silently absent from the JSON, whenever a
# prerequisite (org domain / SPO admin URL) could not be established.
function Test-KeelPrereq {
    param([string]$Workload, [string]$Value, [string]$WhatMissing)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        $reason = if ($script:derivationError) {
            "cannot probe ${Workload}: $WhatMissing unavailable — domain derivation failed: ${script:derivationError}"
        } else {
            "cannot probe ${Workload}: $WhatMissing unavailable"
        }
        Add-Result -Workload $Workload -Connected $false -Cmdlet $null -Ok $false -Count $null -ErrorText $reason
        return $false
    }
    return $true
}

function Invoke-ProbeCmdlet {
    param([string]$Workload, [string]$Name, [scriptblock]$Block)
    try {
        $out = & $Block
        $count = if ($null -eq $out) { 0 } else { @($out).Count }
        Add-Result -Workload $Workload -Connected $true -Cmdlet $Name -Ok $true -Count $count -ErrorText $null
        Write-Diag "$Workload/$Name -> ok, count=$count"
    } catch {
        Add-Result -Workload $Workload -Connected $true -Cmdlet $Name -Ok $false -Count $null -ErrorText $_.Exception.Message
        Write-Diag "$Workload/$Name -> FAILED: $($_.Exception.Message)"
    }
}

# --- Load COLLECTOR credentials ---
Write-Diag "loading credential config from $TenantConfigPath"
$config = Get-Content -Raw -Path $TenantConfigPath | ConvertFrom-Json
$tenantId = $config.tenantId
$clientId = $config.clientId
$certBundle = Get-KeelCertificate -CertPath $config.certPath -KeyPath $config.keyPath
$cert = $certBundle.Certificate

# --- Derive org domain / SPO admin URL empirically from the tenant via Graph. ---
# Never hardcode a guess (task instruction) — read the initial .onmicrosoft.com
# domain and the SharePoint root site from Graph using the COLLECTOR credential's
# own read scopes (Organization read via Global Reader; Sites.Read.All).
$requiresOrgDomain = @('exo', 'scc', 'defender', 'spo')
$needsDomainDerivation = (@($Workloads | Where-Object { $_ -in $requiresOrgDomain })).Count -gt 0
$needsSpoAdminUrl = $Workloads -contains 'spo'
$script:derivationError = $null

if (($needsDomainDerivation -and -not $OrgDomain) -or ($needsSpoAdminUrl -and -not $SpoAdminUrl)) {
    try {
        Write-Diag 'deriving tenant domain / SPO admin site via Graph (Organization + Sites.Read.All)'
        $graphToken = Get-KeelGraphToken -TenantId $tenantId -ClientId $clientId -Certificate $cert
        $graphHeaders = @{ Authorization = "Bearer $graphToken" }

        if (-not $OrgDomain) {
            $org = Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/organization' -Headers $graphHeaders
            $initial = $org.value[0].verifiedDomains | Where-Object { $_.isInitial } | Select-Object -First 1
            if ($initial) { $OrgDomain = $initial.name }
        }

        if ($needsSpoAdminUrl -and -not $SpoAdminUrl) {
            $rootSite = Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/sites/root' -Headers $graphHeaders
            $spHost = ([Uri]$rootSite.webUrl).Host
            $prefix = $spHost.Split('.')[0]
            $SpoAdminUrl = "https://$prefix-admin.sharepoint.com"
        }
        Write-Diag "derived OrgDomain=$OrgDomain SpoAdminUrl=$SpoAdminUrl"
    } catch {
        $script:derivationError = $_.Exception.Message
        Write-Diag "tenant-domain derivation failed: ${script:derivationError}"
    }
}

# Modules are imported lazily, in workload execution order, rather than all
# up front. Measured empirically: importing PnP.PowerShell alongside
# ExchangeOnlineManagement in the same process is fatal — PnP registers a
# global AssemblyLoadContext.Resolving handler
# (PnPPowerShellModuleInitializer.ResolveDependency) that recurses without
# bound when EXO's MSAL token provider tries to resolve an assembly during
# Connect-ExchangeOnline, producing an unrecoverable native stack overflow
# (.NET cannot catch StackOverflowException — it kills the whole process,
# taking every not-yet-run workload down with it). PnP.PowerShell is
# therefore imported last, only immediately before the SPO block, so its
# handler is never registered while EXO/SCC/Teams work is in flight.

# --- Exchange Online ---
if ($Workloads -contains 'exo' -and (Test-KeelPrereq -Workload 'exo' -Value $OrgDomain -WhatMissing 'tenant .onmicrosoft.com domain')) {
    try {
        Import-Module ExchangeOnlineManagement -ErrorAction Stop | Out-Null
        Write-Diag "connecting EXO as $OrgDomain"
        Connect-ExchangeOnline -AppId $clientId -Organization $OrgDomain -Certificate $cert `
            -ShowBanner:$false -ShowProgress:$false | Out-Null
        Add-Result -Workload 'exo' -Connected $true -Cmdlet $null -Ok $true -Count $null -ErrorText $null
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-OrganizationConfig' -Block { Get-OrganizationConfig }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-TransportRule' -Block { Get-TransportRule }
        # Task 101: mailbox client-access settings (configuration only, no mailbox content).
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-CASMailbox' -Block { Get-CASMailbox -ResultSize 1 }
        # Task 105: mailbox hold and retention settings (configuration only).
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-Mailbox' -Block { Get-Mailbox -ResultSize 1 }
        # Issue #153: organization-wide mail flow and protection settings (configuration
        # only). Get-TransportRule is probed above. The last two need Defender for
        # Office 365; in an unlicensed tenant their rows fail with the cmdlet not found.
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-AcceptedDomain' -Block { Get-AcceptedDomain }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-RemoteDomain' -Block { Get-RemoteDomain }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-InboundConnector' -Block { Get-InboundConnector }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-OutboundConnector' -Block { Get-OutboundConnector }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-HostedContentFilterPolicy' -Block { Get-HostedContentFilterPolicy }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-AntiPhishPolicy' -Block { Get-AntiPhishPolicy }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-MalwareFilterPolicy' -Block { Get-MalwareFilterPolicy }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-DkimSigningConfig' -Block { Get-DkimSigningConfig }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-SafeLinksPolicy' -Block { Get-SafeLinksPolicy }
        Invoke-ProbeCmdlet -Workload 'exo' -Name 'Get-SafeAttachmentPolicy' -Block { Get-SafeAttachmentPolicy }
    } catch {
        Add-Result -Workload 'exo' -Connected $false -Cmdlet $null -Ok $false -Count $null -ErrorText $_.Exception.Message
        Write-Diag "exo connect FAILED: $($_.Exception.Message)"
    } finally {
        try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
    }
}

# --- Security & Compliance (SCC) + Defender (same SCC session, per task spec) ---
if (($Workloads -contains 'scc' -or $Workloads -contains 'defender')) {
    $sccPrereqOk = Test-KeelPrereq -Workload 'scc' -Value $OrgDomain -WhatMissing 'tenant .onmicrosoft.com domain'
    if (-not $sccPrereqOk -and $Workloads -contains 'defender' -and -not ($Workloads -contains 'scc')) {
        # scc itself wasn't requested, so add the equivalent missing-prereq row under defender.
        Test-KeelPrereq -Workload 'defender' -Value $OrgDomain -WhatMissing 'tenant .onmicrosoft.com domain' | Out-Null
    }
    if ($sccPrereqOk) {
        try {
            Import-Module ExchangeOnlineManagement -ErrorAction Stop | Out-Null
            Write-Diag "connecting IPPSSession as $OrgDomain"
            Connect-IPPSSession -AppId $clientId -Organization $OrgDomain -Certificate $cert `
                -ShowBanner:$false | Out-Null

            if ($Workloads -contains 'scc') {
                Add-Result -Workload 'scc' -Connected $true -Cmdlet $null -Ok $true -Count $null -ErrorText $null
                Invoke-ProbeCmdlet -Workload 'scc' -Name 'Get-RetentionCompliancePolicy' -Block { Get-RetentionCompliancePolicy }
                Invoke-ProbeCmdlet -Workload 'scc' -Name 'Get-DlpCompliancePolicy' -Block { Get-DlpCompliancePolicy }
                Invoke-ProbeCmdlet -Workload 'scc' -Name 'Get-Label' -Block { Get-Label }
                # Task 101: label publication (policies), not labels applied to items.
                Invoke-ProbeCmdlet -Workload 'scc' -Name 'Get-LabelPolicy' -Block { Get-LabelPolicy }
            }
            if ($Workloads -contains 'defender') {
                Add-Result -Workload 'defender' -Connected $true -Cmdlet $null -Ok $true -Count $null -ErrorText $null
                Invoke-ProbeCmdlet -Workload 'defender' -Name 'Get-AntiPhishPolicy' -Block { Get-AntiPhishPolicy }
                Invoke-ProbeCmdlet -Workload 'defender' -Name 'Get-SafeLinksPolicy' -Block { Get-SafeLinksPolicy }
                Invoke-ProbeCmdlet -Workload 'defender' -Name 'Get-SafeAttachmentPolicy' -Block { Get-SafeAttachmentPolicy }
            }
        } catch {
            $errText = $_.Exception.Message
            if ($Workloads -contains 'scc') {
                Add-Result -Workload 'scc' -Connected $false -Cmdlet $null -Ok $false -Count $null -ErrorText $errText
            }
            if ($Workloads -contains 'defender') {
                Add-Result -Workload 'defender' -Connected $false -Cmdlet $null -Ok $false -Count $null -ErrorText $errText
            }
            Write-Diag "IPPSSession connect FAILED: $errText"
        } finally {
            try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
        }
    }
}

# --- Teams (no org-domain prerequisite — TenantId is used directly) ---
if ($Workloads -contains 'teams') {
    try {
        Import-Module MicrosoftTeams -ErrorAction Stop | Out-Null
        Write-Diag 'connecting Teams'
        Connect-MicrosoftTeams -Certificate $cert -ApplicationId $clientId -TenantId $tenantId | Out-Null
        Add-Result -Workload 'teams' -Connected $true -Cmdlet $null -Ok $true -Count $null -ErrorText $null
        Invoke-ProbeCmdlet -Workload 'teams' -Name 'Get-CsTeamsMeetingPolicy' -Block { Get-CsTeamsMeetingPolicy }
        Invoke-ProbeCmdlet -Workload 'teams' -Name 'Get-CsTenantFederationConfiguration' -Block { Get-CsTenantFederationConfiguration }
    } catch {
        Add-Result -Workload 'teams' -Connected $false -Cmdlet $null -Ok $false -Count $null -ErrorText $_.Exception.Message
        Write-Diag "teams connect FAILED: $($_.Exception.Message)"
    } finally {
        try { Disconnect-MicrosoftTeams -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
    }
}

# --- SharePoint / PnP ---
#
# Measured: PnP.PowerShell 3.4.1's own dependency resolver
# (PnPPowerShellModuleInitializer.ResolveDependency) recurses without bound
# in this container image and crashes the process with a native stack
# overflow — fatal and uncatchable in .NET (try/catch cannot stop it), even
# with PnP imported alone, last, in a process that had never loaded EXO's
# module. So this is not (only) the EXO/PnP co-load conflict it first looked
# like; it reproduces in isolation. Running it in a genuinely separate
# `pwsh` child process contains the blast radius: if the child crashes, only
# the spo rows are lost, not the exo/scc/defender/teams results already
# collected in this process.
if ($Workloads -contains 'spo' -and (Test-KeelPrereq -Workload 'spo' -Value $SpoAdminUrl -WhatMissing 'SPO admin site URL')) {
    if (Test-KeelPrereq -Workload 'spo' -Value $OrgDomain -WhatMissing 'tenant .onmicrosoft.com domain') {
        $childScript = @'
$ErrorActionPreference = "Stop"
$rows = [System.Collections.Generic.List[object]]::new()
try {
    Import-Module PnP.PowerShell -ErrorAction Stop | Out-Null
    Connect-PnPOnline -Url $env:KEEL_SPO_ADMIN_URL -ClientId $env:KEEL_SPO_CLIENT_ID -Tenant $env:KEEL_SPO_TENANT `
        -CertificateBase64Encoded $env:KEEL_SPO_PFX_B64 `
        -CertificatePassword (ConvertTo-SecureString -String $env:KEEL_SPO_PFX_PWD -AsPlainText -Force) | Out-Null
    $rows.Add([ordered]@{ workload = "spo"; connected = $true; cmdlet = $null; ok = $true; count = $null; error = $null })
    foreach ($c in @(
            @{ name = "Get-PnPTenant"; block = { Get-PnPTenant } },
            @{ name = "Get-PnPSite"; block = { Get-PnPSite } },
            @{ name = "Get-PnPTenantSite"; block = { Get-PnPTenantSite } },
            @{ name = "Get-PnPTenantSite -IncludeOneDriveSites"; block = { Get-PnPTenantSite -IncludeOneDriveSites } }
        )) {
        try {
            $out = & $c.block
            $count = if ($null -eq $out) { 0 } else { @($out).Count }
            $rows.Add([ordered]@{ workload = "spo"; connected = $true; cmdlet = $c.name; ok = $true; count = $count; error = $null })
        } catch {
            $rows.Add([ordered]@{ workload = "spo"; connected = $true; cmdlet = $c.name; ok = $false; count = $null; error = $_.Exception.Message })
        }
    }
} catch {
    $rows.Add([ordered]@{ workload = "spo"; connected = $false; cmdlet = $null; ok = $false; count = $null; error = $_.Exception.Message })
} finally {
    try { Disconnect-PnPOnline -ErrorAction SilentlyContinue | Out-Null } catch {}
}
ConvertTo-Json -InputObject $rows -Depth 6
'@

        $env:KEEL_SPO_ADMIN_URL = $SpoAdminUrl
        $env:KEEL_SPO_CLIENT_ID = $clientId
        $env:KEEL_SPO_TENANT = $OrgDomain
        $env:KEEL_SPO_PFX_B64 = $certBundle.PfxBase64
        $env:KEEL_SPO_PFX_PWD = $certBundle.PfxPassword

        $childOutFile = [System.IO.Path]::GetTempFileName()
        $childErrFile = [System.IO.Path]::GetTempFileName()
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))

        try {
            Write-Diag "connecting PnP to $SpoAdminUrl (isolated child process)"
            $proc = Start-Process -FilePath 'pwsh' `
                -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) `
                -NoNewWindow -PassThru -Wait `
                -RedirectStandardOutput $childOutFile -RedirectStandardError $childErrFile

            $childStdout = Get-Content -Raw -Path $childOutFile -ErrorAction SilentlyContinue
            $childStderr = Get-Content -Raw -Path $childErrFile -ErrorAction SilentlyContinue

            $childRows = $null
            if ($proc.ExitCode -eq 0 -and $childStdout) {
                try { $childRows = $childStdout | ConvertFrom-Json } catch { $childRows = $null }
            }

            if ($childRows) {
                foreach ($row in @($childRows)) { $results.Add($row) }
                Write-Diag "spo child process exited 0, $(@($childRows).Count) row(s)"
            } else {
                $snippet = if ($childStderr) { ($childStderr -split "`n" | Select-Object -First 3) -join ' | ' } else { '(no stderr captured)' }
                Add-Result -Workload 'spo' -Connected $false -Cmdlet $null -Ok $false -Count $null `
                    -ErrorText "spo child process crashed or produced no JSON (exit=$($proc.ExitCode)): $snippet"
                Write-Diag "spo child process FAILED (exit=$($proc.ExitCode)): $snippet"
            }
        } catch {
            Add-Result -Workload 'spo' -Connected $false -Cmdlet $null -Ok $false -Count $null -ErrorText $_.Exception.Message
            Write-Diag "spo child process launch FAILED: $($_.Exception.Message)"
        } finally {
            Remove-Item -Path $childOutFile, $childErrFile -ErrorAction SilentlyContinue
            Remove-Item Env:\KEEL_SPO_ADMIN_URL, Env:\KEEL_SPO_CLIENT_ID, Env:\KEEL_SPO_TENANT, Env:\KEEL_SPO_PFX_B64, Env:\KEEL_SPO_PFX_PWD -ErrorAction SilentlyContinue
        }
    }
}

# --- Task 101: stamp each row with the module version it ran under ---
# Rows from the spo child process arrive as PSCustomObject, the rest as ordered
# dictionaries; both are rebuilt into one shape here. The version is the highest
# installed one, which is what Import-Module loaded above.
$moduleFor = @{ exo = 'ExchangeOnlineManagement'; scc = 'ExchangeOnlineManagement'; defender = 'ExchangeOnlineManagement'; teams = 'MicrosoftTeams'; spo = 'PnP.PowerShell' }
$versionOf = @{}
foreach ($name in ($moduleFor.Values | Sort-Object -Unique)) {
    $installed = Get-Module -ListAvailable -Name $name | Sort-Object Version -Descending | Select-Object -First 1
    $versionOf[$name] = if ($installed) { $installed.Version.ToString() } else { $null }
}
$stamped = [System.Collections.Generic.List[object]]::new()
foreach ($row in $results) {
    $module = $moduleFor[[string]$row.workload]
    $stamped.Add([ordered]@{
            workload      = $row.workload
            connected     = $row.connected
            cmdlet        = $row.cmdlet
            ok            = $row.ok
            count         = $row.count
            error         = $row.error
            module        = $module
            moduleVersion = if ($module) { $versionOf[$module] } else { $null }
            capturedAt    = $capturedAt
            synthetic     = $false
        })
}

# --- Emit canonical JSON to stdout ONLY ---
# Bound via -InputObject (not the pipeline) so 0-, 1-, and N-element results all
# serialize as a JSON array — PowerShell's pipeline unwraps a single-element
# collection into a bare object otherwise, a well-known ConvertTo-Json gotcha.
ConvertTo-Json -InputObject $stamped -Depth 6
