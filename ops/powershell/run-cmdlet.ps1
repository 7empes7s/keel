#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL PowerShell plane: run ONE allowlisted Exchange Online cmdlet (roadmap task-105).

.DESCRIPTION
  Reads the job descriptor from $env:KEEL_JOB_JSON:
    { mode: "cmdlet", module, cmdlet, parameters: { Name: value, ... }, tenantConfigPath? }
  There is no script field and nothing here builds PowerShell source from the job.
  The cmdlet name must be in $Allowed and every parameter name in its list. Values
  are bound by splatting a hashtable, so each value is exactly one argument: a
  mailbox identity such as  o'brien'; Remove-Mailbox x  is passed literally.

  Answers one JSON envelope on stdout:
    { ok: true,  output: [...] }                               exit 0
    { ok: false, error: { message, category, errorId } }       exit 1
  A cmdlet error is never reported as an empty success.

  Fixture-tested only through engine/roadmap/exchange-config.test.mjs (which plays
  this contract); it has not been run against a tenant.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# Cmdlet -> parameter names it may receive. Reads take only -Identity. Writes take
# the exact settings KEEL restores (engine/coverage/qualification.mjs).
$Allowed = @{
    'Get-OrganizationConfig' = @()
    'Get-Mailbox'            = @('Identity')
    'Get-CASMailbox'         = @('Identity')
    'Set-CASMailbox'         = @('Identity', 'OWAEnabled', 'ActiveSyncEnabled', 'PopEnabled', 'ImapEnabled', 'MAPIEnabled', 'EwsEnabled', 'SmtpClientAuthenticationDisabled')
    'Set-Mailbox'            = @('Identity', 'LitigationHoldEnabled', 'RetentionHoldEnabled', 'SingleItemRecoveryEnabled', 'RetainDeletedItemsFor')
    'Set-OrganizationConfig' = @('FocusedInboxOn', 'MailTipsAllTipsEnabled', 'MailTipsExternalRecipientsTipsEnabled', 'MailTipsGroupMetricsEnabled', 'MailTipsLargeAudienceThreshold', 'OAuth2ClientProfileEnabled', 'SmtpActionableMessagesEnabled', 'ConnectorsEnabled')
}

function Out-Envelope {
    param([hashtable]$Envelope, [int]$Code)
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Envelope -Depth 8 -Compress))
    exit $Code
}

function Out-Failure {
    param([string]$Message, [string]$Category = $null, [string]$ErrorId = $null)
    Out-Envelope -Envelope @{ ok = $false; error = @{ message = $Message; category = $Category; errorId = $ErrorId } } -Code 1
}

try {
    $job = $env:KEEL_JOB_JSON | ConvertFrom-Json -AsHashtable
} catch {
    Out-Failure -Message "job descriptor is not valid JSON: $($_.Exception.Message)" -ErrorId 'BadDescriptor'
}

$name = [string]$job['cmdlet']
if (-not $Allowed.ContainsKey($name)) { Out-Failure -Message "cmdlet $name is not allowed" -ErrorId 'CmdletNotAllowed' }
$params = @{}
if ($null -ne $job['parameters']) {
    foreach ($key in $job['parameters'].Keys) {
        if ($Allowed[$name] -notcontains $key) { Out-Failure -Message "parameter $key is not allowed for $name" -ErrorId 'ParameterNotAllowed' }
        $value = $job['parameters'][$key]
        if ($value -is [System.Collections.IDictionary]) { Out-Failure -Message "parameter $key must be a scalar" -ErrorId 'ParameterNotScalar' }
        $params[$key] = $value
    }
}

$tenantConfigPath = if ($job['tenantConfigPath']) { [string]$job['tenantConfigPath'] } else { '/etc/keel/tenant.json' }
try {
    $config = Get-Content -Raw -Path $tenantConfigPath | ConvertFrom-Json
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
    Import-Module ExchangeOnlineManagement -ErrorAction Stop | Out-Null
    Connect-ExchangeOnline -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false -ShowProgress:$false | Out-Null
} catch {
    Out-Failure -Message "could not connect to Exchange Online: $($_.Exception.Message)" -Category 'ConnectionError' -ErrorId 'ConnectFailed'
}

try {
    $output = & $name @params -ErrorAction Stop
    Out-Envelope -Envelope @{ ok = $true; output = @($output) } -Code 0
} catch {
    $record = $_
    Out-Failure -Message $record.Exception.Message -Category ([string]$record.CategoryInfo.Category) -ErrorId ([string]$record.FullyQualifiedErrorId)
} finally {
    try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
}
