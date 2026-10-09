#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL PowerShell plane: run ONE allowlisted Exchange Online, Security & Compliance
  (Purview) or PnP cmdlet (roadmap tasks 105 and 106).

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

  Fixture-tested only through engine/roadmap/exchange-config.test.mjs,
  engine/roadmap/onedrive-purview.test.mjs and engine/roadmap/exchange-mail-flow.test.mjs
  (which play this contract); it has not been run against a tenant.
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

# Task-106: Purview label configuration runs in the Security & Compliance session
# (Connect-IPPSSession). Only label DEFINITIONS and publishing policies: no cmdlet
# here reads a labeled item or label usage. Writes take display text and AddLabels.
$AllowedPurview = @{
    'Get-Label'       = @()
    'Get-LabelPolicy' = @()
    'Set-Label'       = @('Identity', 'DisplayName', 'Tooltip', 'Comment')
    'Set-LabelPolicy' = @('Identity', 'AddLabels')
}

# Issue #153: organization-wide mail flow and protection settings, read in the
# Exchange Online session with no parameters. Reads only: no Set-, New- or Remove-.
$AllowedMailFlow = @{
    'Get-AcceptedDomain'            = @()
    'Get-RemoteDomain'              = @()
    'Get-TransportRule'             = @()
    'Get-InboundConnector'          = @()
    'Get-OutboundConnector'         = @()
    'Get-HostedContentFilterPolicy' = @()
    'Get-AntiPhishPolicy'           = @()
    'Get-MalwareFilterPolicy'       = @()
    'Get-DkimSigningConfig'         = @()
    'Get-SafeLinksPolicy'           = @()
    'Get-SafeAttachmentPolicy'      = @()
}

# Task-106: OneDrive site-level settings through PnP, one named site at a time.
# No file, folder or list-item cmdlet is allowed.
$AllowedPnP = @{
    'Get-PnPTenantSite' = @('Identity')
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
$module = [string]$job['module']
# Each cmdlet belongs to exactly one session, and the job's module must match it.
if ($Allowed.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $Allowed[$name] }
elseif ($AllowedMailFlow.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'exo'; $permitted = $AllowedMailFlow[$name] }
elseif ($AllowedPurview.ContainsKey($name) -and $module -eq 'ExchangeOnlineManagement') { $session = 'ipps'; $permitted = $AllowedPurview[$name] }
elseif ($AllowedPnP.ContainsKey($name) -and $module -eq 'PnP.PowerShell') { $session = 'pnp'; $permitted = $AllowedPnP[$name] }
else { Out-Failure -Message "cmdlet $name is not allowed" -ErrorId 'CmdletNotAllowed' }
$params = @{}
if ($null -ne $job['parameters']) {
    foreach ($key in $job['parameters'].Keys) {
        if ($permitted -notcontains $key) { Out-Failure -Message "parameter $key is not allowed for $name" -ErrorId 'ParameterNotAllowed' }
        $value = $job['parameters'][$key]
        if ($value -is [System.Collections.IDictionary]) { Out-Failure -Message "parameter $key must be a scalar" -ErrorId 'ParameterNotScalar' }
        $params[$key] = $value
    }
}

$tenantConfigPath = if ($job['tenantConfigPath']) { [string]$job['tenantConfigPath'] } else { '/etc/keel/tenant.json' }
try {
    $config = Get-Content -Raw -Path $tenantConfigPath | ConvertFrom-Json
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
    if ($session -eq 'pnp') {
        # PnP is never loaded beside ExchangeOnlineManagement (see probe-workloads.ps1).
        Import-Module PnP.PowerShell -ErrorAction Stop | Out-Null
        $pfx = [Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
        Connect-PnPOnline -Url $config.sharePointAdminUrl -ClientId $config.clientId -Tenant $config.organization -CertificateBase64Encoded $pfx | Out-Null
    } else {
        Import-Module ExchangeOnlineManagement -ErrorAction Stop | Out-Null
        if ($session -eq 'ipps') {
            Connect-IPPSSession -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false | Out-Null
        } else {
            Connect-ExchangeOnline -AppId $config.clientId -Organization $config.organization -Certificate $cert -ShowBanner:$false -ShowProgress:$false | Out-Null
        }
    }
} catch {
    Out-Failure -Message "could not connect ($session): $($_.Exception.Message)" -Category 'ConnectionError' -ErrorId 'ConnectFailed'
}

try {
    # Warnings from the module's own functions ignore this script's $WarningPreference and
    # would land on stdout ahead of the envelope (Get-LabelPolicy: "Force Validate not set").
    $output = & $name @params -ErrorAction Stop 3>$null
    Out-Envelope -Envelope @{ ok = $true; output = @($output) } -Code 0
} catch {
    $record = $_
    Out-Failure -Message $record.Exception.Message -Category ([string]$record.CategoryInfo.Category) -ErrorId ([string]$record.FullyQualifiedErrorId)
} finally {
    if ($session -eq 'pnp') { try { Disconnect-PnPOnline -ErrorAction SilentlyContinue | Out-Null } catch {} }
    else { try { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {} }
}
