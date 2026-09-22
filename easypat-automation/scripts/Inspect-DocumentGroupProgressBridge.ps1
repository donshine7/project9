param()
$ErrorActionPreference = 'Stop'
$bridgeProgress = $null
$bridgeIntermediate = $null
$bridgeProcess = $null

function Wait-ForFiddlerCopy([string]$Instruction) {
    Add-Type -AssemblyName PresentationFramework
    $message = $Instruction + "`n`nFiddler에서 복사만 한 뒤 확인을 누르세요." +
        "`nPowerShell 창에는 내용을 붙여넣지 마세요."
    $null = [System.Windows.MessageBox]::Show($message, 'EasyPAT 연결 검사', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Information)
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }
    $env:EASYPAT_PWSH_PATH = Join-Path $PSHOME 'pwsh.exe'
    Wait-ForFiddlerCopy '1/2 기존 세션 174 → Response → Body → Text의 응답 본문 전체를 복사하세요.'
    $bridgeProgress = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($bridgeProgress)) { throw 'Progress response unavailable' }
    Wait-ForFiddlerCopy '2/2 기존 세션 245 → Response → Body → Text의 응답 본문 전체를 복사하세요.'
    $bridgeIntermediate = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($bridgeIntermediate)) { throw 'Intermediate response unavailable' }
    $bridgePayload = @{progressResponse=$bridgeProgress;intermediateResponse=$bridgeIntermediate} | ConvertTo-Json -Compress
    $bridgeProgress = $null
    $bridgeIntermediate = $null
    $bridgeNode = Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'
    $bridgeStart = [System.Diagnostics.ProcessStartInfo]::new($bridgeNode)
    $bridgeStart.ArgumentList.Add((Join-Path $PSScriptRoot '..\src\inspect-document-group-progress-bridge.mjs'))
    $bridgeStart.UseShellExecute = $false
    $bridgeStart.CreateNoWindow = $true
    $bridgeStart.RedirectStandardInput = $true
    $bridgeStart.RedirectStandardOutput = $true
    $bridgeStart.RedirectStandardError = $true
    $bridgeStart.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $bridgeProcess = [System.Diagnostics.Process]::Start($bridgeStart)
    $bridgeStdout = $bridgeProcess.StandardOutput.ReadToEndAsync()
    $bridgeStderr = $bridgeProcess.StandardError.ReadToEndAsync()
    $bridgeProcess.StandardInput.Write($bridgePayload)
    $bridgeProcess.StandardInput.Close()
    $bridgePayload = $null
    if (-not $bridgeProcess.WaitForExit(60000)) { $bridgeProcess.Kill(); throw 'Inspection timed out' }
    $bridgeOutput = if ($bridgeProcess.ExitCode -eq 0) { $bridgeStdout.Result } else { $bridgeStderr.Result }
    $bridgeSummary = $bridgeOutput | ConvertFrom-Json
    if ($bridgeSummary.serverRequestsPerformed -ne 0 -or $bridgeSummary.productionEnabled -ne $false -or
        ($bridgeSummary.rawValuesReturned -ne $false -and $bridgeSummary.rawRowsReturned -ne $false) -or
        $bridgeSummary.status -notmatch '^document-group-progress-bridge-(validated|rejected)$') { throw 'Summary rejected' }
    Write-Output ($bridgeSummary | ConvertTo-Json -Depth 6 -Compress)
    exit $bridgeProcess.ExitCode
} catch {
    Write-Output '{"status":"document-group-progress-bridge-helper-rejected","rawValuesReturned":false,"serverRequestsPerformed":0,"productionEnabled":false}'
    exit 1
} finally {
    $bridgeProgress = $null
    $bridgeIntermediate = $null
    $bridgePayload = $null
    if ($null -ne $bridgeProcess) { $bridgeProcess.Dispose() }
}
