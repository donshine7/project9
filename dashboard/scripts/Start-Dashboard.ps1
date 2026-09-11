[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $env:LOCALAPPDATA 'SSPAT\dashboard-runtime'
$dashboardUrl = 'http://127.0.0.1:4173/'

try {
  try {
    $existingResponse = Invoke-WebRequest -UseBasicParsing -Uri $dashboardUrl -TimeoutSec 2
    if ([int]$existingResponse.StatusCode -ge 200 -and [int]$existingResponse.StatusCode -lt 400) {
      Write-Host "이미 실행 중인 대시보드를 엽니다: $dashboardUrl"
      Start-Process $dashboardUrl
      exit 0
    }
  }
  catch {
    # 기존 서버가 없으면 아래 초기화·실행 절차를 계속한다.
  }

  $npmCommand = Get-Command npm -ErrorAction Stop
  $npmPath = if ($npmCommand.Source) { $npmCommand.Source } elseif ($npmCommand.Path) { $npmCommand.Path } else { $null }
  if (-not $npmPath) {
    throw 'Get-Command npm이 실행 파일 경로를 반환하지 않았습니다.'
  }

  $robocopyCommand = Get-Command robocopy -ErrorAction Stop
  $robocopyPath = if ($robocopyCommand.Source) { $robocopyCommand.Source } elseif ($robocopyCommand.Path) { $robocopyCommand.Path } else { $null }
  if (-not $robocopyPath) {
    throw 'Get-Command robocopy가 실행 파일 경로를 반환하지 않았습니다.'
  }

  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $excludedDirs = @('node_modules', 'dist', '.vinext', '.wrangler', '.git') | ForEach-Object {
    Join-Path $sourceDir $_
  }

  Write-Host "OneDrive 원본을 실행 전용 경로에 동기화합니다: $runtimeDir"
  $robocopyArgs = @(
    $sourceDir,
    $runtimeDir,
    '/E',
    '/XD'
  ) + $excludedDirs + @('/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS')
  & $robocopyPath @robocopyArgs
  $syncCode = $LASTEXITCODE
  if ($syncCode -ge 8) {
    throw "소스 동기화에 실패했습니다. robocopy 오류 코드: $syncCode"
  }

  $vinextCommand = Join-Path $runtimeDir 'node_modules\.bin\vinext.cmd'
  if (-not (Test-Path -LiteralPath $vinextCommand)) {
    Write-Host '실행 전용 경로에 의존성이 없어 최초 1회 설치를 시작합니다.'
    Push-Location -LiteralPath $runtimeDir
    try {
      & $npmPath install --legacy-peer-deps --no-audit --no-fund
      $installCode = $LASTEXITCODE
    }
    finally {
      Pop-Location
    }
    if ($installCode -ne 0) {
      throw "의존성 설치에 실패했습니다. 실제 npm 오류 코드: $installCode (설치 위치: $runtimeDir)"
    }
  }

  if (-not (Test-Path -LiteralPath $vinextCommand)) {
    throw "설치 후에도 vinext 실행 파일을 찾지 못했습니다: $vinextCommand"
  }

  $helperPath = Join-Path $runtimeDir 'scripts\Open-DashboardWhenReady.ps1'
  if (-not (Test-Path -LiteralPath $helperPath)) {
    throw "브라우저 대기 스크립트를 찾을 수 없습니다: $helperPath"
  }
  Write-Host "서버가 준비되면 브라우저를 엽니다: $dashboardUrl"
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $helperPath,
    '-Url',
    $dashboardUrl,
    '-TimeoutSeconds',
    '60'
  ) | Out-Null

  Write-Host '상상특허 업무 자동화 대시보드를 시작합니다.'
  Write-Host "실행 전용 경로: $runtimeDir"
  Write-Host 'Vinext 개발 서버 로그는 이 창에 표시됩니다.'
  Push-Location -LiteralPath $runtimeDir
  try {
    & $npmPath run dev
    $devCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($devCode -ne 0) {
    throw "npm run dev가 종료되었습니다. 실제 오류 코드: $devCode"
  }
}
catch {
  Write-Error ("대시보드 시작 실패: " + $_.Exception.Message)
  exit 1
}

exit 0
