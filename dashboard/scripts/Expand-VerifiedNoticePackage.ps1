param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9()_.-]{4,64}$')][string]$ExpectedMatterReference,
  [Parameter(Mandatory = $true)][ValidateSet('opinion_submission', 'rejection_decision', 'priority_exam_supplement_request')][string]$ExpectedNoticeKind
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sha256Hex([string]$Path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

$zip = [System.IO.Path]::GetFullPath($ZipPath)
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$zipInfo = Get-Item -LiteralPath $zip -Force
$outputInfo = Get-Item -LiteralPath $output -Force
if (-not $zipInfo.PSIsContainer -and ($zipInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { } else { throw 'PROJECT_PACKAGE_INPUT_REJECTED' }
if (-not $outputInfo.PSIsContainer -or ($outputInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROJECT_OUTPUT_REJECTED' }

$actualHash = Get-Sha256Hex $zip
if ($actualHash -ne $ExpectedSha256) { throw 'PROJECT_PACKAGE_HASH_MISMATCH' }
if ($zipInfo.Length -gt 536870912) { throw 'PROJECT_PACKAGE_TOO_LARGE' }

$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  if ($archive.Entries.Count -lt 2 -or $archive.Entries.Count -gt 1000) { throw 'PROJECT_PACKAGE_ENTRY_COUNT_REJECTED' }
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $total = [int64]0
  $items = @()
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name -match '^[A-Za-z]:' -or $name.Contains([char]0)) { throw 'PROJECT_PACKAGE_ENTRY_REJECTED' }
    $parts = $name.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)
    $unsafeParts = @($parts | Where-Object { $_ -eq '..' -or $_ -eq '.' })
    if ($parts.Count -eq 0 -or $unsafeParts.Count -gt 0) { throw 'PROJECT_PACKAGE_ENTRY_REJECTED' }
    if ([string]::IsNullOrEmpty($entry.Name)) { continue }
    if ($entry.Length -gt 67108864) { throw 'PROJECT_PACKAGE_ENTRY_TOO_LARGE' }
    $total += $entry.Length
    if ($total -gt 536870912) { throw 'PROJECT_PACKAGE_TOO_LARGE' }
    $target = [System.IO.Path]::GetFullPath((Join-Path $output ($parts -join [System.IO.Path]::DirectorySeparatorChar)))
    $prefix = $output.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'PROJECT_PACKAGE_PATH_TRAVERSAL' }
    if (-not $seen.Add($target)) { throw 'PROJECT_PACKAGE_DUPLICATE_ENTRY' }
    $parent = [System.IO.Path]::GetDirectoryName($target)
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    $entryStream = $entry.Open()
    $file = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $entryStream.CopyTo($file) } finally { $file.Dispose(); $entryStream.Dispose() }
    $written = Get-Item -LiteralPath $target -Force
    if ($written.Length -ne $entry.Length -or ($written.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROJECT_PACKAGE_EXTRACT_VERIFY_REJECTED' }
    $items += [pscustomobject]@{ name = $name; size = [int64]$entry.Length; sha256 = (Get-Sha256Hex $target) }
  }
} finally {
  $archive.Dispose()
}

$manifestPath = Join-Path $output 'download-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'PROJECT_PACKAGE_MANIFEST_MISSING' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.itemCount -ne ($items.Count - 1) -or [string]$manifest.matterReference -cne $ExpectedMatterReference -or [string]$manifest.noticeKind -cne $ExpectedNoticeKind) { throw 'PROJECT_PACKAGE_MANIFEST_REJECTED' }
foreach ($manifestItem in $manifest.items) {
  $entryName = [string]$manifestItem.archiveEntry
  $match = @($items | Where-Object { $_.name -ceq $entryName })
  if ($match.Count -ne 1 -or $match[0].size -ne [int64]$manifestItem.fileSizeBytes -or $match[0].sha256 -ne ([string]$manifestItem.sha256).ToLowerInvariant()) { throw 'PROJECT_PACKAGE_MANIFEST_HASH_MISMATCH' }
}

[pscustomobject]@{
  ok = $true
  itemCount = $items.Count - 1
  totalBytes = $total
  packageSha256 = $actualHash
} | ConvertTo-Json -Compress
