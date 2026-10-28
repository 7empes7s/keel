#Requires -Version 7.0
<#
.SYNOPSIS
  KEEL PowerShell plane: the JSON fallback run-cmdlet.ps1 uses when ConvertTo-Json
  cannot serialise a cmdlet's answer (issue #638 and queue item Q179).

.DESCRIPTION
  Two answer shapes break ConvertTo-Json outright:
    - PnP / CSOM objects (Get-PnPHubSite, Get-PnPSiteDesign, Get-PnPSiteScript) carry
      collections that were never loaded. Enumerating one throws
      CollectionNotInitializedException.
    - Purview objects (Get-DlpSensitiveInformationType) carry dictionaries whose keys
      are not strings (NonStringKeyInDictionary).

  ConvertTo-KeelPlain copies a value into plain hashtables and arrays first:
    - a property whose getter or enumeration throws is left out (it was not loaded,
      so there is nothing to back up);
    - every dictionary key becomes a string;
    - CSOM plumbing (Context, Tag, Path, ObjectVersion, ServerObjectIsNull,
      TypedObject) is left out of SharePoint client objects;
    - like ConvertTo-Json -Depth, a value nested deeper than the depth is written as
      its string, and an object that contains itself is written as its string.
  Scalars (strings, numbers, booleans, enums, Guids, dates, byte arrays) are kept as
  they are, so ConvertTo-Json writes them exactly as it would have.

  run-cmdlet.ps1 tries ConvertTo-Json first and uses this only when that throws, so
  answers that already serialise are written byte for byte as before. A failure inside
  an array element is not hidden: it fails the property (or, at the top, the answer).

  Tested by ops/powershell/keel-json.tests.ps1 (pwsh) through
  engine/powershell/keel-json.test.mjs.
#>

$KeelJsonClientObjectPlumbing = @('Context', 'Tag', 'Path', 'ObjectVersion', 'ServerObjectIsNull', 'TypedObject')

function Test-KeelJsonScalar {
    param($Value)
    return ($Value -is [string] -or $Value -is [char] -or $Value -is [bool] -or $Value -is [enum] -or
        $Value -is [guid] -or $Value -is [datetime] -or $Value -is [datetimeoffset] -or $Value -is [timespan] -or
        $Value -is [uri] -or $Value -is [byte[]] -or $Value -is [System.DBNull] -or
        ($Value -is [System.ValueType] -and $Value.GetType().IsPrimitive) -or $Value -is [decimal] -or
        $Value -is [System.Numerics.BigInteger])
}

# A property's value. PowerShell turns a .NET getter that throws into $null, which would
# write an unloaded CSOM property (PropertyOrFieldNotInitializedException) as a null
# setting, so a .NET property is read through its getter and a throw is passed on.
function Get-KeelJsonPropertyValue {
    param($Base, [System.Management.Automation.PSPropertyInfo]$Property)
    if ($Property -is [System.Management.Automation.PSProperty]) {
        $info = $null
        try { $info = $Base.GetType().GetProperty($Property.Name, [System.Reflection.BindingFlags]'Public, Instance') } catch { $info = $null }
        if ($null -ne $info -and $info.CanRead -and $info.GetIndexParameters().Count -eq 0) {
            return , $info.GetValue($Base)
        }
    }
    return , $Property.Value
}

function ConvertTo-KeelPlainValue {
    param($Value, [int]$Depth, [System.Collections.Generic.HashSet[object]]$Path)

    if ($null -eq $Value) { return $null }
    # Never `$base = if (...)`: an if used as a value unrolls a one-item array.
    $base = $Value
    if ($Value -is [psobject]) { $base = $Value.PSObject.BaseObject }
    if (Test-KeelJsonScalar $base) { return , $base }
    if ($Depth -lt 0) { return [string]$base }
    if (-not $Path.Add($base)) { return [string]$base }
    try {
        if ($base -is [System.Collections.IDictionary]) {
            $plain = [ordered]@{}
            foreach ($entry in $base.GetEnumerator()) {
                $key = if ($null -eq $entry.Key) { '' } else { [string]$entry.Key }
                $plain[$key] = ConvertTo-KeelPlainValue -Value $entry.Value -Depth ($Depth - 1) -Path $Path
            }
            return $plain
        }
        if ($base -is [System.Collections.IEnumerable]) {
            $list = [System.Collections.Generic.List[object]]::new()
            foreach ($item in $base) { $list.Add((ConvertTo-KeelPlainValue -Value $item -Depth ($Depth - 1) -Path $Path)) }
            return , $list.ToArray()
        }
        $isClientObject = $Value.PSObject.TypeNames -contains 'Microsoft.SharePoint.Client.ClientObject'
        $plain = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            if (-not $property.IsGettable) { continue }
            if ($isClientObject -and $KeelJsonClientObjectPlumbing -contains $property.Name) { continue }
            try {
                $plain[$property.Name] = ConvertTo-KeelPlainValue -Value (Get-KeelJsonPropertyValue -Base $base -Property $property) -Depth ($Depth - 1) -Path $Path
            } catch {
                # Not loaded (CSOM) or not readable: nothing to back up, so leave it out.
                continue
            }
        }
        return $plain
    } finally {
        [void]$Path.Remove($base)
    }
}

function ConvertTo-KeelPlain {
    param($Value, [int]$Depth = 16)
    $path = [System.Collections.Generic.HashSet[object]]::new([System.Collections.Generic.ReferenceEqualityComparer]::Instance)
    return , (ConvertTo-KeelPlainValue -Value $Value -Depth $Depth -Path $path)
}

# The envelope as compressed JSON: ConvertTo-Json as before, and the plain copy only when that throws.
function ConvertTo-KeelJson {
    param($Value, [int]$Depth = 16)
    try {
        return ConvertTo-Json -InputObject $Value -Depth $Depth -Compress -ErrorAction Stop
    } catch {
        $plain = ConvertTo-KeelPlain -Value $Value -Depth $Depth
        # The copy is already cut at $Depth, so this depth only has to clear it.
        return ConvertTo-Json -InputObject $plain -Depth ($Depth + 4) -Compress -ErrorAction Stop
    }
}
