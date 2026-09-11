[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 _-]{1,79}$')]
  [string]$ProjectName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PtCaseNumbersCsv
)

$ErrorActionPreference = 'Stop'
$root = 'C:\ChatGPT\AI-Work\10_특허\한국특허가출원'
$projectPath = Join-Path -Path $root -ChildPath $ProjectName
$stagingPath = $null

try {
  if ($ProjectName.Contains('..') -or $ProjectName.Contains('\') -or $ProjectName.Contains('/')) {
    throw '프로젝트명에 경로 구분자를 사용할 수 없습니다.'
  }

  # Node에서 PowerShell 배열을 여러 인자로 넘길 때 발생하는 경계 문제를 피하기 위해
  # API는 CSV 한 개의 인자로 전달하고 여기서만 목록으로 분해한다.
  $normalizedCases = @($PtCaseNumbersCsv -split '[,;\s]+' | ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
  if ($normalizedCases.Count -eq 0) {
    throw 'PT 사건번호가 필요합니다.'
  }
  foreach ($caseNumber in $normalizedCases) {
    if ($caseNumber -notmatch '^PT\d{6}(?:-[A-Z0-9]+)*$') {
      throw "허용되지 않은 PT 사건번호입니다: $caseNumber"
    }
  }

  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "고정 작업 루트가 존재하지 않습니다. 먼저 다음 경로를 확인하세요: $root"
  }
  if (Test-Path -LiteralPath $projectPath) {
    throw "동일한 프로젝트 폴더가 이미 존재합니다: $projectPath"
  }

  $stagingPath = Join-Path -Path $root -ChildPath ('.staging-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingPath '10_source_original') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingPath '40_draft') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingPath 'outputs') -Force | Out-Null

  $agents = @'
# AGENTS.md

## 한국특허 가출원 프로젝트

- 원본 자료는 `10_source_original`에 보관한다.
- 계약과 상태 파일을 먼저 확인한다.
- DOCX를 중간 산출물로 만들지 않고 HWPX를 직접 생성한다.
- 독립 구조·의미 검사와 전 페이지 시각 검수를 통과한 결과만 `outputs`로 승격한다.
'@
  Set-Content -LiteralPath (Join-Path $stagingPath 'AGENTS.md') -Value $agents -Encoding utf8

  $projectDoc = [ordered]@{
    projectName = $ProjectName
    ptCaseNumbers = $normalizedCases
    createdAt = (Get-Date).ToString('o')
    workflow = '한국특허 가출원'
  }
  $projectDoc | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stagingPath 'patent.project.json') -Encoding utf8

  $projectReadme = @"
# $ProjectName

한국특허 가출원 작업 프로젝트입니다.

## PT 사건번호

$($normalizedCases -join ', ')

## 시작 단계

원본 자료를 `10_source_original`에 투입한 뒤 소스 분석을 시작합니다.
"@
  Set-Content -LiteralPath (Join-Path $stagingPath 'PROJECT.md') -Value $projectReadme -Encoding utf8

  $lock = [ordered]@{
    version = 1
    projectName = $ProjectName
    createdAt = (Get-Date).ToString('o')
    root = '10_source_original'
  }
  $lock | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stagingPath 'harness.lock.json') -Encoding utf8

  $harness = @'
param([string]$Action = 'status')
Write-Output "한국특허 가출원 harness: $Action"
'@
  Set-Content -LiteralPath (Join-Path $stagingPath 'run-harness.ps1') -Value $harness -Encoding utf8

  $status = [ordered]@{
    version = 1
    projectName = $ProjectName
    ptCaseNumbers = $normalizedCases
    currentStage = 3
    status = '사용자 작업 필요'
    blocked = $false
    note = '원본 자료를 10_source_original에 투입하세요.'
    updatedAt = (Get-Date).ToString('o')
  }
  $status | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stagingPath 'workflow-status.json') -Encoding utf8

  if (Test-Path -LiteralPath $projectPath) {
    throw "동일한 프로젝트 폴더가 이미 존재합니다: $projectPath"
  }
  Move-Item -LiteralPath $stagingPath -Destination $projectPath
  $stagingPath = $null
  Write-Output $projectPath
}
catch {
  if ($stagingPath -and (Test-Path -LiteralPath $stagingPath) -and $stagingPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $stagingPath).StartsWith('.staging-')) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw
}
