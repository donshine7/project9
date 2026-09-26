[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RunnerRoot,

  [Parameter(Mandatory = $true)]
  [string]$GraderRoot
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runnerPath = [System.IO.Path]::GetFullPath($RunnerRoot)
$graderPath = [System.IO.Path]::GetFullPath($GraderRoot)

if ([StringComparer]::OrdinalIgnoreCase.Equals($runnerPath, $graderPath)) {
  throw 'RunnerRoot와 GraderRoot는 서로 달라야 합니다.'
}
foreach ($target in @($runnerPath, $graderPath)) {
  if (Test-Path -LiteralPath $target) {
    throw "기존 폴더를 덮어쓰지 않습니다: $target"
  }
}

try {
  New-Item -ItemType Directory -Path $runnerPath | Out-Null
  New-Item -ItemType Directory -Path $graderPath | Out-Null
  foreach ($relative in @('contracts', 'datasets', 'runs')) {
    New-Item -ItemType Directory -Path (Join-Path $runnerPath $relative) | Out-Null
  }
  foreach ($relative in @('contracts', 'graders\dev', 'rubrics', 'baselines', 'reports')) {
    New-Item -ItemType Directory -Path (Join-Path $graderPath $relative) | Out-Null
  }

  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\project-templates\runner\AGENTS.md') -Destination $runnerPath
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\project-templates\runner\README.md') -Destination $runnerPath
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\project-templates\grader\AGENTS.md') -Destination $graderPath
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\project-templates\grader\README.md') -Destination $graderPath
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\contracts\wiki-eval-run-manifest.schema.json') -Destination (Join-Path $runnerPath 'contracts')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\contracts\wiki-eval-run-manifest.schema.json') -Destination (Join-Path $graderPath 'contracts')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\datasets\wiki-dev-v1') -Destination (Join-Path $runnerPath 'datasets') -Recurse
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\datasets\wiki-vertical-v1') -Destination (Join-Path $runnerPath 'datasets') -Recurse
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\graders\dev\wiki-dev-v1.expected.json') -Destination (Join-Path $graderPath 'graders\dev')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\graders\dev\wiki-vertical-v1.expected.json') -Destination (Join-Path $graderPath 'graders\dev')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\graders\dev\wiki-cutover-v1.expected.json') -Destination (Join-Path $graderPath 'graders\dev')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'eval\graders\dev\wiki-scale-v1.expected.json') -Destination (Join-Path $graderPath 'graders\dev')

  $runnerForbidden = Get-ChildItem -LiteralPath $runnerPath -Recurse -File |
    Where-Object { $_.Name -match '(?i)(expected|answer|holdout|rubric|grader)' }
  if ($runnerForbidden) {
    throw "Runner 프로젝트에 금지된 정답 계열 파일이 있습니다: $($runnerForbidden.FullName -join ', ')"
  }
} catch {
  foreach ($target in @($runnerPath, $graderPath)) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
  throw
}

[pscustomobject]@{
  RunnerRoot = $runnerPath
  GraderRoot = $graderPath
  RunnerContainsAnswers = $false
  OperationalDataCopied = $false
}
