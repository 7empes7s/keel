<#
.SYNOPSIS
  Probe: can Microsoft365DSC write, from a Linux container, a setting KEEL has no writer for?

.DESCRIPTION
  Run once, by hand, in a throwaway PowerShell 7.6 container (Microsoft365DSC 2.x needs 7.6).
  It installs Microsoft365DSC at a pinned version, connects app-only with the certificate in
  -TenantConfigPath (the Exchange Restorer), and drives one resource, EXODistributionGroup,
  on one test fixture only:

    1. Get     the fixture (expected absent)
    2. Set     Ensure=Present            -> creates the KEEL-RT- distribution list
    3. Get     read it back
    4. Set     a new Description         -> changes it
    5. Test    against that Description  -> expected true
    6. Set     Ensure=Absent             -> removes the fixture
    7. Get     expected absent

  The fixture name must start with KEEL-RT-; the script refuses anything else. It never runs a
  whole configuration, never touches another object, and removes the fixture at the end (also
  when a step fails). Writes one JSON line per step to stdout and a summary to -Out.
#>
param(
    [string] $TenantConfigPath = '/etc/keel/exchange-restorer.json',
    [string] $Fixture = 'KEEL-RT-DSC-probe-DL',
    [string] $ModuleVersion = '2.26.1021.1',
    [string] $OrgDomain,
    [string] $Out = '/out'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $Fixture.StartsWith('KEEL-RT-')) { throw 'dsc-probe: the fixture name must start with KEEL-RT-' }

$steps = [System.Collections.Generic.List[object]]::new()
function Write-Step([string] $Name, [string] $Outcome, $Detail, [double] $Seconds) {
    $text = if ($null -eq $Detail) { $null } else { ([string]$Detail) -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[address]' -replace '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '[id]' -replace '\b[a-z0-9-]+\.onmicrosoft\.com\b', '[tenant host]' }
    if ($text -and $text.Length -gt 600) { $text = $text.Substring(0, 600) }
    $row = [ordered]@{ step = $Name; outcome = $Outcome; detail = $text; seconds = [math]::Round($Seconds, 1) }
    $steps.Add($row)
    $row | ConvertTo-Json -Compress | Write-Output
}
function Invoke-Step([string] $Name, [scriptblock] $Block) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $Block
        Write-Step $Name 'ok' $result $watch.Elapsed.TotalSeconds
        return $result
    } catch {
        Write-Step $Name 'failed' $_.Exception.Message $watch.Elapsed.TotalSeconds
        return $null
    }
}

Write-Step 'powershell' 'info' "PowerShell $($PSVersionTable.PSVersion) on $($PSVersionTable.OS)" 0

# 1. Module install (timed: this is the cost of a DSC profile).
Invoke-Step 'install Microsoft365DSC' {
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
    Install-Module -Name Microsoft365DSC -RequiredVersion $ModuleVersion -Scope CurrentUser -Force -AllowClobber -Repository PSGallery
    "Microsoft365DSC $ModuleVersion"
} | Out-Null
Invoke-Step 'install dependencies' {
    Import-Module Microsoft365DSC -RequiredVersion $ModuleVersion -Force
    Update-M365DSCDependencies -Scope CurrentUser | Out-Null
    $size = (Get-ChildItem -Recurse -File ($env:PSModulePath -split [IO.Path]::PathSeparator | Where-Object { Test-Path $_ }) -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    "modules on disk: $([math]::Round($size / 1MB)) MB"
} | Out-Null
Invoke-Step 'install PSDesiredStateConfiguration' {
    Install-Module -Name PSDesiredStateConfiguration -RequiredVersion 2.0.7 -Scope CurrentUser -Force -Repository PSGallery
    Import-Module PSDesiredStateConfiguration -RequiredVersion 2.0.7 -Force
    'PSDesiredStateConfiguration 2.0.7'
} | Out-Null

# 2. Credential: the PEM pair, turned into a temporary PFX inside the container only.
$config = Get-Content -Raw -Path $TenantConfigPath | ConvertFrom-Json
$raw = [System.Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile($config.certPath, $config.keyPath)
$pfxPassword = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$pfxPath = Join-Path ([IO.Path]::GetTempPath()) "keel-dsc-$([guid]::NewGuid()).pfx"
[IO.File]::WriteAllBytes($pfxPath, $raw.Export('Pkcs12', $pfxPassword))
if (-not $IsWindows) { chmod 600 $pfxPath }
$secure = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
$pfxPassword = $null
if (-not $OrgDomain) { $OrgDomain = $config.orgDomain }
if (-not $OrgDomain) { throw 'dsc-probe: pass -OrgDomain (the tenant''s initial onmicrosoft.com domain)' }
$auth = @{
    ApplicationId       = $config.clientId
    TenantId            = $OrgDomain
    CertificatePath     = $pfxPath
    CertificatePassword = [pscredential]::new('pfx', $secure)
}

# Invoke-DscResource first; if it cannot drive the class-based resource on Linux, call the class directly.
$script:Mode = $null
function Invoke-Resource([string] $Method, [hashtable] $Property) {
    $all = $auth + $Property
    if ($script:Mode -ne 'class') {
        try {
            $answer = Invoke-DscResource -Name EXODistributionGroup -ModuleName @{ ModuleName = 'Microsoft365DSC'; ModuleVersion = $ModuleVersion } -Method $Method -Property $all
            $script:Mode = 'Invoke-DscResource'
            return $answer
        } catch {
            if ($script:Mode -eq 'Invoke-DscResource') { throw }
            Write-Step 'Invoke-DscResource' 'failed' $_.Exception.Message 0
            $script:Mode = 'class'
        }
    }
    $make = [scriptblock]::Create('using module Microsoft365DSC; [EXODistributionGroup]::new()')
    $resource = & $make
    foreach ($key in $all.Keys) { $resource.$key = $all[$key] }
    switch ($Method) { 'Get' { $resource.Get() } 'Set' { $resource.Set(); 'set' } 'Test' { $resource.Test() } }
}
function Summarise($answer) {
    if ($null -eq $answer) { return 'no answer' }
    $state = if ($answer.PSObject.Properties['Ensure']) { $answer.Ensure } elseif ($answer.PSObject.Properties['InDesiredState']) { "InDesiredState=$($answer.InDesiredState)" } else { [string]$answer }
    $description = if ($answer.PSObject.Properties['Description']) { " description='$($answer.Description)'" } else { '' }
    "mode=$script:Mode ensure=$state$description"
}

$key = @{ Identity = $Fixture; Name = $Fixture }
try {
    Invoke-Step '1 get (expect absent)' { Summarise (Invoke-Resource 'Get' ($key + @{ Ensure = 'Present' })) } | Out-Null
    Invoke-Step '2 set present' { Invoke-Resource 'Set' ($key + @{ Ensure = 'Present'; DisplayName = $Fixture; Alias = ($Fixture -replace '[^A-Za-z0-9-]', ''); Description = 'KEEL DSC probe: created' }) | Out-Null; "mode=$script:Mode" } | Out-Null
    Invoke-Step '3 get (expect present)' { Summarise (Invoke-Resource 'Get' ($key + @{ Ensure = 'Present' })) } | Out-Null
    Invoke-Step '4 set description' { Invoke-Resource 'Set' ($key + @{ Ensure = 'Present'; Description = 'KEEL DSC probe: changed' }) | Out-Null; "mode=$script:Mode" } | Out-Null
    Invoke-Step '5 test (expect true)' { Summarise (Invoke-Resource 'Test' ($key + @{ Ensure = 'Present'; Description = 'KEEL DSC probe: changed' })) } | Out-Null
} finally {
    Invoke-Step '6 set absent (clean up)' { Invoke-Resource 'Set' ($key + @{ Ensure = 'Absent' }) | Out-Null; "mode=$script:Mode" } | Out-Null
    Invoke-Step '7 get (expect absent)' { Summarise (Invoke-Resource 'Get' ($key + @{ Ensure = 'Present' })) } | Out-Null
    Remove-Item -Force $pfxPath -ErrorAction SilentlyContinue
    $memory = [math]::Round([Diagnostics.Process]::GetCurrentProcess().PeakWorkingSet64 / 1MB)
    Write-Step 'peak memory' 'info' "$memory MB" 0
    if (Test-Path $Out) {
        [ordered]@{ fixture = $Fixture; module = "Microsoft365DSC $ModuleVersion"; steps = $steps } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $Out 'dsc-probe.json')
    }
}
