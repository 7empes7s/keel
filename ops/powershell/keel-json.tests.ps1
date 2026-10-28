#Requires -Version 7.0
# Checks for keel-json.ps1, run by engine/powershell/keel-json.test.mjs. No tenant, no
# modules: the two answer shapes that broke ConvertTo-Json are rebuilt with small .NET
# types. Prints one line per check and exits 1 on the first failure.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'keel-json.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
namespace KeelJsonTest {
  // What CSOM throws when an unloaded collection is enumerated (#638).
  public class CollectionNotInitializedException : InvalidOperationException {
    public CollectionNotInitializedException() : base("The collection has not been initialized. It has not been requested or the request has not been executed. It may need to be explicitly requested.") {}
  }
  public class UnloadedCollection : IEnumerable {
    public IEnumerator GetEnumerator() { throw new CollectionNotInitializedException(); }
  }
  public class FakeContext {
    public FakeContext Self { get { return this; } }
    public string Url { get { return "https://contoso-admin.sharepoint.com"; } }
  }
  public enum JoinMode { Open = 0, Approval = 1 }
  public class FakeHubSite {
    public string Title { get { return "KEEL-RT-hub"; } }
    public Guid ID { get { return new Guid("11111111-2222-3333-4444-555555555555"); } }
    public Guid[] Targets { get { return new Guid[] { new Guid("66666666-7777-8888-9999-000000000000") }; } }
    public bool RequiresJoinApproval { get { return false; } }
    public JoinMode Mode { get { return JoinMode.Approval; } }
    public UnloadedCollection Sites { get { return new UnloadedCollection(); } }
    public string NotLoaded { get { throw new CollectionNotInitializedException(); } }
    public FakeContext Context { get { return new FakeContext(); } }
  }
  public class SelfLoop {
    public string Name { get { return "loop"; } }
    public SelfLoop Me { get { return this; } }
  }
}
'@

$script:count = 0
function Assert-Equal {
    param([string]$Name, $Actual, $Expected)
    if ($Actual -cne $Expected) {
        [Console]::Error.WriteLine("FAIL $Name`n  expected: $Expected`n  actual:   $Actual")
        exit 1
    }
    $script:count++
    [Console]::Out.WriteLine("ok $Name")
}
function Assert-Throws {
    param([string]$Name, [scriptblock]$Block, [string]$ErrorIdLike)
    try { & $Block | Out-Null } catch {
        if ($_.FullyQualifiedErrorId -notlike $ErrorIdLike) {
            [Console]::Error.WriteLine("FAIL $Name`n  expected error like: $ErrorIdLike`n  actual: $($_.FullyQualifiedErrorId)")
            exit 1
        }
        $script:count++
        [Console]::Out.WriteLine("ok $Name")
        return
    }
    [Console]::Error.WriteLine("FAIL $Name`n  expected an error, got none")
    exit 1
}

# 1. #638: an unloaded CSOM collection breaks ConvertTo-Json; the plain copy leaves it out.
$hub = [psobject]::new([KeelJsonTest.FakeHubSite]::new())
$hub.PSObject.TypeNames.Insert(0, 'Microsoft.SharePoint.Client.ClientObject')
$envelope = @{ ok = $true; output = @($hub) }
Assert-Throws 'ConvertTo-Json still fails on an unloaded collection' { ConvertTo-Json -InputObject $envelope -Depth 16 -Compress } '*CollectionNotInitializedException,*'
$parsed = ConvertTo-KeelJson -Value $envelope -Depth 16 | ConvertFrom-Json -AsHashtable
Assert-Equal 'hub site: envelope ok' $parsed['ok'] $true
Assert-Equal 'hub site: one answer, still a list' $parsed['output'].Count 1
$item = $parsed['output'][0]
Assert-Equal 'hub site: Title kept' $item['Title'] 'KEEL-RT-hub'
Assert-Equal 'hub site: Guid written as its string' $item['ID'] '11111111-2222-3333-4444-555555555555'
Assert-Equal 'hub site: Guid list kept as a list' (@($item['Targets']) -join ',') '66666666-7777-8888-9999-000000000000'
Assert-Equal 'hub site: false kept' $item['RequiresJoinApproval'] $false
Assert-Equal 'hub site: enum written as its number, as ConvertTo-Json does' $item['Mode'] 1
Assert-Equal 'hub site: unloaded collection left out' $item.Contains('Sites') $false
Assert-Equal 'hub site: unloaded property left out' $item.Contains('NotLoaded') $false
Assert-Equal 'hub site: CSOM Context left out' $item.Contains('Context') $false

# A plain .NET object (not a CSOM client object) keeps a property named Context.
$plainHub = ConvertTo-KeelPlain -Value ([KeelJsonTest.FakeHubSite]::new()) -Depth 4
Assert-Equal 'non-CSOM object keeps Context' $plainHub.Contains('Context') $true

# 2. Q179: a dictionary with non-string keys breaks ConvertTo-Json; keys become strings.
$names = [System.Collections.Hashtable]::new()
$names[[cultureinfo]'en-US'] = 'Credit Card Number'
$names[1036] = 'Numéro de carte'
$type = [pscustomobject]@{ Name = 'Credit Card Number'; Id = [guid]'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; AllLocalizedNames = $names; Publisher = 'Microsoft Corporation' }
$envelope = @{ ok = $true; output = @($type) }
Assert-Throws 'ConvertTo-Json still fails on non-string keys' { ConvertTo-Json -InputObject $envelope -Depth 16 -Compress } 'NonStringKeyInDictionary,*'
$parsed = ConvertTo-KeelJson -Value $envelope -Depth 16 | ConvertFrom-Json -AsHashtable
$item = $parsed['output'][0]
Assert-Equal 'sensitive info type: culture key as its name' $item['AllLocalizedNames']['en-US'] 'Credit Card Number'
Assert-Equal 'sensitive info type: number key as its digits' $item['AllLocalizedNames']['1036'] 'Numéro de carte'
Assert-Equal 'sensitive info type: other fields kept' "$($item['Name'])|$($item['Id'])|$($item['Publisher'])" 'Credit Card Number|aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee|Microsoft Corporation'

# Nested custom objects (and deserialized ones, as Exchange Online and Purview answer)
# under a fallback answer keep their settings: every PSCustomObject shares one base.
$innerNames = [System.Collections.Hashtable]::new(); $innerNames[1033] = 'one'
$nested = [pscustomobject]@{ Name = 't'; Inner = [pscustomobject]@{ Value = 'kept'; Deeper = [pscustomobject]@{ Leaf = 2 } }; List = @([pscustomobject]@{ A = 1 }, [pscustomobject]@{ A = 2 }); Keys = $innerNames }
$parsed = ConvertTo-KeelJson -Value @{ ok = $true; output = @($nested) } -Depth 16 | ConvertFrom-Json -AsHashtable
$item = $parsed['output'][0]
Assert-Equal 'nested custom object kept' $item['Inner']['Value'] 'kept'
Assert-Equal 'custom object two levels down kept' $item['Inner']['Deeper']['Leaf'] 2
Assert-Equal 'custom objects in a list kept' ((@($item['List']) | ForEach-Object { $_['A'] }) -join ',') '1,2'
$deserialized = [System.Management.Automation.PSSerializer]::Deserialize([System.Management.Automation.PSSerializer]::Serialize($nested, 5))
$deserialized.PSObject.Properties.Remove('Keys'); $deserialized | Add-Member -NotePropertyName Keys -NotePropertyValue $innerNames
$parsed = ConvertTo-KeelJson -Value @{ ok = $true; output = @($deserialized) } -Depth 16 | ConvertFrom-Json -AsHashtable
Assert-Equal 'deserialized nested object kept' $parsed['output'][0]['Inner']['Deeper']['Leaf'] 2
Assert-Equal 'deserialized non-string key as its digits' $parsed['output'][0]['Keys']['1033'] 'one'

# Keys that differ only in case stay two keys, as ConvertTo-Json writes them.
$cased = [System.Collections.Generic.Dictionary[string, int]]::new()
$cased['Name'] = 1; $cased['name'] = 2
Assert-Equal 'case-only key difference kept' (ConvertTo-Json -InputObject (ConvertTo-KeelPlain -Value $cased) -Compress) (ConvertTo-Json -InputObject $cased -Compress)

# 3. Answers that already serialise are written byte for byte as ConvertTo-Json writes them.
$when = [datetime]::new(2026, 10, 28, 8, 0, 0, [DateTimeKind]::Utc)
$samples = @(
    @{ ok = $true; output = @() },
    @{ ok = $true; output = @([pscustomobject]@{ Name = 'KEEL-RT-a'; Count = 3; Enabled = $true; Missing = $null; When = $when; List = @('x'); Empty = @() }) },
    @{ ok = $false; error = @{ message = 'the cmdlet failed'; category = 'InvalidOperation'; errorId = 'X' } },
    @{ ok = $true; output = @([pscustomobject]@{ Nested = [pscustomobject]@{ Inner = [pscustomobject]@{ Value = 1.5 } }; Bytes = [byte[]](60, 0, 63, 0) }) }
)
$i = 0
foreach ($sample in $samples) {
    $i++
    Assert-Equal "unchanged answer $i" (ConvertTo-KeelJson -Value $sample -Depth 16) (ConvertTo-Json -InputObject $sample -Depth 16 -Compress)
}

# 4. The plain copy itself writes the same JSON as ConvertTo-Json for shapes both can write,
#    including what lies past the depth (written as its string).
$deep = [ordered]@{ a = [ordered]@{ b = [ordered]@{ c = [ordered]@{ d = 'leaf' } } }; list = @(1, @(2, @(3, [ordered]@{ e = 'x' }))); when = $when; bytes = [byte[]](1, 2) }
foreach ($depth in 1, 2, 3, 16) {
    Assert-Equal "plain copy matches ConvertTo-Json at depth $depth" (ConvertTo-Json -InputObject (ConvertTo-KeelPlain -Value $deep -Depth $depth) -Depth 100 -Compress) (ConvertTo-Json -InputObject $deep -Depth $depth -Compress -WarningAction SilentlyContinue)
}

# 5. An object that contains itself ends as its string instead of looping.
$loop = ConvertTo-KeelPlain -Value ([KeelJsonTest.SelfLoop]::new()) -Depth 16
Assert-Equal 'self loop: name kept' $loop['Name'] 'loop'
Assert-Equal 'self loop: the repeat is its string' $loop['Me'] 'KeelJsonTest.SelfLoop'

# 6. A failing list element is never hidden: at the top it fails the whole answer.
$envelope = @{ ok = $true; output = [KeelJsonTest.UnloadedCollection]::new() }
Assert-Throws 'a top-level list that cannot be read still fails' { ConvertTo-KeelJson -Value $envelope -Depth 16 } 'ExceptionInGetEnumerator*'

[Console]::Out.WriteLine("passed $($script:count)")
