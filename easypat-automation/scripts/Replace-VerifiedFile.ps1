param(
  [Parameter(Mandatory = $true)][string]$TemporaryPath,
  [Parameter(Mandatory = $true)][string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
$temporary = (Resolve-Path -LiteralPath $TemporaryPath).Path
$destination = (Resolve-Path -LiteralPath $DestinationPath).Path
$temporaryInfo = Get-Item -LiteralPath $temporary
$destinationInfo = Get-Item -LiteralPath $destination
if ($temporaryInfo.PSIsContainer -or $destinationInfo.PSIsContainer) { throw 'VERIFIED_REPLACE_INPUT_REJECTED' }
function Test-UnsafeLink([System.IO.FileInfo]$item) {
  $linkTypeProperty = $item.PSObject.Properties['LinkType']
  if ($null -ne $linkTypeProperty -and -not [string]::IsNullOrWhiteSpace([string]$linkTypeProperty.Value)) { return $true }
  $targetProperty = $item.PSObject.Properties['Target']
  if ($null -ne $targetProperty -and $null -ne $targetProperty.Value -and @($targetProperty.Value).Count -gt 0) { return $true }
  return $false
}
# OneDrive marks ordinary hydrated files as ReparsePoint.  Reject actual links,
# while allowing those cloud-file attributes after both files were fully read
# and hash-verified by the caller.
if ((Test-UnsafeLink $temporaryInfo) -or (Test-UnsafeLink $destinationInfo)) { throw 'VERIFIED_REPLACE_INPUT_REJECTED' }
if (-not [System.IO.Path]::GetDirectoryName($temporary).Equals([System.IO.Path]::GetDirectoryName($destination), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'VERIFIED_REPLACE_INPUT_REJECTED' }
if (-not $temporaryInfo.Name.StartsWith('.') -or -not $temporaryInfo.Name.EndsWith('.partial')) { throw 'VERIFIED_REPLACE_INPUT_REJECTED' }
try {
  [System.IO.File]::Replace($temporary, $destination, $null, $true)
} catch {
  $swap = Join-Path ([System.IO.Path]::GetDirectoryName($destination)) ('.' + [System.IO.Path]::GetFileName($destination) + '.' + [System.Guid]::NewGuid().ToString() + '.swap')
  $swapped = $false
  try {
    [System.IO.File]::Move($destination, $swap)
    $swapped = $true
    [System.IO.File]::Move($temporary, $destination)
    [System.IO.File]::Delete($swap)
    $swapped = $false
  } catch {
    if ($swapped -and -not [System.IO.File]::Exists($destination) -and [System.IO.File]::Exists($swap)) { [System.IO.File]::Move($swap, $destination); $swapped = $false }
    try {
      [System.IO.File]::Copy($temporary, $destination, $true)
      [System.IO.File]::Delete($temporary)
    } catch { throw 'VERIFIED_REPLACE_LOCKED' }
  }
}
