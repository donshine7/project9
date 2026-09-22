[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$IsolatedRoot,

  [ValidateSet('development', 'eval', 'test')]
  [string]$Profile = 'development',

  [ValidateRange(1024, 65535)]
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$dashboardRoot = Split-Path -Parent $PSScriptRoot
$resolvedRoot = [System.IO.Path]::GetFullPath($IsolatedRoot)
$npmCommand = Get-Command npm -ErrorAction Stop
$npmPath = if ($npmCommand.Source) { $npmCommand.Source } elseif ($npmCommand.Path) { $npmCommand.Path } else { $null }
if (-not $npmPath) {
  throw 'Get-Command npm이 실행 파일 경로를 반환하지 않았습니다.'
}

$env:SSPAT_RUNTIME_PROFILE = $Profile
$env:SSPAT_ISOLATED_ROOT = $resolvedRoot
$env:SSPAT_WORK_DB_PATH = Join-Path $resolvedRoot 'db\work.db'
$env:SSPAT_WIKI_VAULT_PATH = Join-Path $resolvedRoot 'vault'
$env:SSPAT_NOTICE_PROJECT_ROOT = Join-Path $resolvedRoot 'cases\notice'
$env:SSPAT_SPEC_PROJECT_ROOT = Join-Path $resolvedRoot 'cases\specification'
$env:SSPAT_PROVISIONAL_PROJECT_ROOT = Join-Path $resolvedRoot 'cases\provisional'
$env:SSPAT_PROJECT_ROOT = Split-Path -Parent $dashboardRoot

@(
  (Split-Path -Parent $env:SSPAT_WORK_DB_PATH),
  $env:SSPAT_WIKI_VAULT_PATH,
  $env:SSPAT_NOTICE_PROJECT_ROOT,
  $env:SSPAT_SPEC_PROJECT_ROOT,
  $env:SSPAT_PROVISIONAL_PROJECT_ROOT
) | ForEach-Object {
  New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

Write-Host "격리 대시보드를 시작합니다: $Profile"
Write-Host "격리 루트: $resolvedRoot"
Write-Host "주소: http://127.0.0.1:$Port/"

Push-Location -LiteralPath $dashboardRoot
try {
  & $npmPath run dev -- --port $Port
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
