param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$EntryListPath
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$listPath = (Resolve-Path -LiteralPath $EntryListPath).Path
$output = [System.IO.Path]::GetFullPath($OutputPath)
$outputParent = [System.IO.Path]::GetDirectoryName($output)
if (-not [System.IO.Directory]::Exists($outputParent) -or [System.IO.File]::Exists($output)) { throw 'UTF8_ZIP_OUTPUT_REJECTED' }
$entries = @((Get-Content -Raw -LiteralPath $listPath -Encoding UTF8 | ConvertFrom-Json))
if ($entries.Count -lt 1 -or $entries.Count -gt 501) { throw 'UTF8_ZIP_ENTRY_LIST_REJECTED' }

$files = foreach ($entryValue in $entries) {
  if ($entryValue -isnot [string]) { throw 'UTF8_ZIP_ENTRY_REJECTED' }
  $entry = $entryValue.Replace('\', '/')
  if (-not $entry -or $entry.StartsWith('/') -or $entry.Contains([char]0) -or $entry -match '(^|/)\.\.(/|$)') { throw 'UTF8_ZIP_ENTRY_REJECTED' }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $source ($entry.Replace('/', [System.IO.Path]::DirectorySeparatorChar))))
  $prefix = $source.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'UTF8_ZIP_ENTRY_REJECTED' }
  $item = Get-Item -LiteralPath $candidate
  if (-not $item.PSIsContainer -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
    [pscustomobject]@{ Entry = $entry; Path = $candidate; LastWriteTime = $item.LastWriteTime }
  } else { throw 'UTF8_ZIP_ENTRY_REJECTED' }
}
if (($files.Entry | Sort-Object -Unique).Count -ne $files.Count) { throw 'UTF8_ZIP_ENTRY_LIST_REJECTED' }

$stream = $null
$archive = $null
try {
  $stream = [System.IO.FileStream]::new($output, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  $encoding = [System.Text.UTF8Encoding]::new($false, $true)
  $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false, $encoding)
  foreach ($file in $files) {
    $zipEntry = $archive.CreateEntry($file.Entry, [System.IO.Compression.CompressionLevel]::Optimal)
    $zipEntry.LastWriteTime = $file.LastWriteTime
    $inputStream = [System.IO.File]::OpenRead($file.Path)
    $outputStream = $zipEntry.Open()
    try { $inputStream.CopyTo($outputStream) }
    finally { $outputStream.Dispose(); $inputStream.Dispose() }
  }
} catch {
  if ($archive) { $archive.Dispose(); $archive = $null }
  if ($stream) { $stream.Dispose(); $stream = $null }
  if ([System.IO.File]::Exists($output)) { [System.IO.File]::Delete($output) }
  throw
} finally {
  if ($archive) { $archive.Dispose() }
  if ($stream) { $stream.Dispose() }
}
