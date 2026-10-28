#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL DSC profile: drive ONE allowlisted Microsoft365DSC resource, one call at a time.

.DESCRIPTION
  Runs only in the keel-dsc image (ops/powershell/Dockerfile.dsc), which holds
  Microsoft365DSC at the version pinned below. Reads the job from $env:KEEL_JOB_JSON:

    { mode: "dsc", resource: "EXODistributionGroup", moduleVersion: "2.26.1021.1",
      calls: [ { method: "Get" | "Test" | "Set", properties: { Name: value, ... } }, ... ],
      tenantConfigPath? }

  There is no script field. The resource must be in $AllowedDsc, every property name in
  its list, and every value a scalar or a list of strings. A Set must carry
  Ensure = 'Present': KEEL never removes an object through DSC. Credential properties
  (ApplicationId, CertificatePath, ...) are never taken from the job: they are built here
  from the tenant config, as a temporary PFX that is removed when the job ends.

  The resource is driven through its class (Microsoft365DSC 2.x resources are
  class-based; the probe of 2026-10-27 proved this route). A whole configuration is
  never compiled or applied.

  Answers one JSON envelope on stdout:
    { ok: true, moduleVersion, results: [ { method, ok, state?, missing?, error? }, ... ] }   exit 0
    { ok: false, error: { message, category, errorId } }                                   exit 1
  Each call gets its own result, in order. A Get answers `state`: the allowlisted
  properties the resource returned, and `missing`: allowlisted names the loaded resource
  does not have (so a live capture shows a name that does not match the module).

  Fixture-tested only through engine/roadmap/dsc-distribution-groups.test.mjs, which plays
  this contract; its live proof is tools/qualification/dscDistributionGroupsLive.mjs.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# The Microsoft365DSC version the image pins (Dockerfile.dsc). A job asking for another
# version is refused: a write proof is bound to the module version it ran on.
$PinnedModuleVersion = '2.26.1021.1'

# Resource -> the properties KEEL sends or reads. Same lists as
# engine/restore/workloads/dscDistributionGroups.mjs (DSC_RESOURCES); a test keeps them equal.
# No trust, certificate, federation or sign-in field is ever listed here.
$AllowedDsc = @{
    'EXODistributionGroup' = @(
        'Identity', 'Name', 'Ensure', 'DisplayName', 'Alias', 'PrimarySmtpAddress', 'Type',
        'HiddenFromAddressListsEnabled', 'MemberJoinRestriction', 'MemberDepartRestriction',
        'RequireSenderAuthenticationEnabled', 'ModerationEnabled', 'SendModerationNotifications',
        'SendOofMessageToOriginatorEnabled',
        # Read only: compared and listed for an administrator, never sent.
        'ManagedBy', 'ModeratedBy', 'GrantSendOnBehalfTo', 'EmailAddresses',
        'AcceptMessagesOnlyFromSendersOrMembers', 'RejectMessagesFromSendersOrMembers', 'Members'
    )
}
# Properties a Set may carry. Everything else in the list above is read only.
$Writable = @{
    'EXODistributionGroup' = @(
        'Identity', 'Name', 'Ensure', 'DisplayName', 'Alias', 'PrimarySmtpAddress', 'Type',
        'HiddenFromAddressListsEnabled', 'MemberJoinRestriction', 'MemberDepartRestriction',
        'RequireSenderAuthenticationEnabled', 'ModerationEnabled', 'SendModerationNotifications',
        'SendOofMessageToOriginatorEnabled'
    )
}
$Methods = @('Get', 'Test', 'Set')
$MaxCalls = 200
$MaxValueLength = 1024

function Out-Envelope {
    param([hashtable]$Envelope, [int]$Code)
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Envelope -Depth 8 -Compress))
    exit $Code
}
function Out-Failure {
    param([string]$Message, [string]$Category = $null, [string]$ErrorId = $null)
    Out-Envelope -Envelope @{ ok = $false; error = @{ message = $Message; category = $Category; errorId = $ErrorId } } -Code 1
}

# A value KEEL may pass: null, a boolean, a number, a bounded string, or a list of bounded strings.
function Test-KeelValue {
    param($Value)
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return $true }
    if ($Value -is [string]) { return $Value.Length -le $MaxValueLength -and $Value -notmatch '[\x00-\x1f\x7f]' }
    if ($Value -is [System.Collections.IList] -and $Value -isnot [System.Collections.IDictionary]) {
        foreach ($item in $Value) { if ($item -isnot [string] -or -not (Test-KeelValue $item)) { return $false } }
        return $true
    }
    return $false
}

try {
    $job = $env:KEEL_JOB_JSON | ConvertFrom-Json -AsHashtable
} catch {
    Out-Failure -Message "job descriptor is not valid JSON: $($_.Exception.Message)" -ErrorId 'BadDescriptor'
}

# 1. Everything about the job is checked before the module loads or anything connects.
$resource = [string]$job['resource']
if (-not $AllowedDsc.ContainsKey($resource)) { Out-Failure -Message "DSC resource $resource is not allowed" -ErrorId 'ResourceNotAllowed' }
if ([string]$job['moduleVersion'] -ne $PinnedModuleVersion) {
    Out-Failure -Message "the job asks for Microsoft365DSC $($job['moduleVersion']); this profile runs $PinnedModuleVersion" -ErrorId 'ModuleVersionMismatch'
}
$calls = @($job['calls'])
if ($calls.Count -eq 0 -or $calls.Count -gt $MaxCalls) { Out-Failure -Message "a DSC job carries 1 to $MaxCalls calls" -ErrorId 'BadDescriptor' }
foreach ($call in $calls) {
    if ($call -isnot [System.Collections.IDictionary]) { Out-Failure -Message 'each call must be an object' -ErrorId 'BadDescriptor' }
    $method = [string]$call['method']
    if ($Methods -cnotcontains $method) { Out-Failure -Message "method $method is not allowed" -ErrorId 'MethodNotAllowed' }
    $properties = $call['properties']
    if ($properties -isnot [System.Collections.IDictionary]) { Out-Failure -Message 'properties must be an object' -ErrorId 'BadDescriptor' }
    $permitted = if ($method -eq 'Set') { $Writable[$resource] } else { $AllowedDsc[$resource] }
    foreach ($key in $properties.Keys) {
        if ($permitted -cnotcontains $key) { Out-Failure -Message "property $key is not allowed for $method on $resource" -ErrorId 'PropertyNotAllowed' }
        if (-not (Test-KeelValue $properties[$key])) { Out-Failure -Message "property $key must be a scalar or a list of strings" -ErrorId 'PropertyNotScalar' }
    }
    foreach ($key in 'Identity', 'Name') {
        if (-not ($properties[$key] -is [string]) -or -not $properties[$key]) { Out-Failure -Message "every call names the object by Identity and Name" -ErrorId 'BadDescriptor' }
    }
    if ($method -eq 'Set' -and $properties['Ensure'] -cne 'Present') {
        Out-Failure -Message 'a Set must carry Ensure = Present: KEEL never removes an object through DSC' -ErrorId 'RemoveNotAllowed'
    }
}

# 2. The pinned module, and the connection built from the tenant config.
$tenantConfigPath = if ($job['tenantConfigPath']) { [string]$job['tenantConfigPath'] } else { '/etc/keel/tenant.json' }
$pfxDir = $null
try {
    $config = Get-Content -Raw -Path $tenantConfigPath | ConvertFrom-Json
    if (-not $config.organization) { throw 'the config names no organization (the tenant''s onmicrosoft.com domain)' }
    $module = Get-Module -ListAvailable Microsoft365DSC | Where-Object { [string]$_.Version -eq $PinnedModuleVersion } | Select-Object -First 1
    if (-not $module) { throw "Microsoft365DSC $PinnedModuleVersion is not installed in this image" }
    $raw = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
    $pfxPassword = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    $pfxDir = Join-Path ([IO.Path]::GetTempPath()) "keel-dsc-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $pfxDir | Out-Null
    if (-not $IsWindows) { chmod 700 $pfxDir }
    $pfxPath = Join-Path $pfxDir 'c.pfx'
    [IO.File]::WriteAllBytes($pfxPath, $raw.Export('Pkcs12', $pfxPassword))
    if (-not $IsWindows) { chmod 600 $pfxPath }
    $auth = @{
        ApplicationId       = [string]$config.clientId
        TenantId            = [string]$config.organization
        CertificatePath     = $pfxPath
        CertificatePassword = [pscredential]::new('pfx', (ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force))
    }
    $pfxPassword = $null
    $make = [scriptblock]::Create("using module '$(Join-Path $module.ModuleBase 'Microsoft365DSC.psd1')'; [$resource]::new()")
} catch {
    if ($pfxDir) { Remove-Item -Recurse -Force $pfxDir -ErrorAction SilentlyContinue }
    Out-Failure -Message "could not prepare the DSC connection: $($_.Exception.Message)" -Category 'ConnectionError' -ErrorId 'ConnectFailed'
}

# 3. One call at a time, each with its own result.
$results = [System.Collections.Generic.List[object]]::new()
try {
    foreach ($call in $calls) {
        $method = [string]$call['method']
        $row = [ordered]@{ method = $method; ok = $false }
        try {
            $instance = & $make
            $names = @($instance.PSObject.Properties.Name)
            foreach ($key in $call['properties'].Keys) {
                if ($names -cnotcontains $key) { throw "the $resource resource in Microsoft365DSC $PinnedModuleVersion has no property $key" }
                $instance.$key = $call['properties'][$key]
            }
            foreach ($key in $auth.Keys) { $instance.$key = $auth[$key] }
            switch ($method) {
                'Get' {
                    $answer = $instance.Get()
                    $state = [ordered]@{}
                    $missing = @()
                    foreach ($name in $AllowedDsc[$resource]) {
                        if ($answer.PSObject.Properties[$name]) { $state[$name] = $answer.$name } else { $missing += $name }
                    }
                    $row.state = $state
                    $row.missing = $missing
                }
                'Test' { $row.inDesiredState = [bool]$instance.Test() }
                'Set' { $instance.Set() | Out-Null }
            }
            $row.ok = $true
        } catch {
            $row.error = @{ message = $_.Exception.Message; category = [string]$_.CategoryInfo.Category; errorId = [string]$_.FullyQualifiedErrorId }
        }
        $results.Add($row)
    }
} finally {
    if ($pfxDir) { Remove-Item -Recurse -Force $pfxDir -ErrorAction SilentlyContinue }
}
Out-Envelope -Envelope @{ ok = $true; moduleVersion = $PinnedModuleVersion; results = @($results) } -Code 0
