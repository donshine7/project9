param()
$ErrorActionPreference = 'Stop'
$sourceResponse = $null
$sourceProcess = $null
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }
    $env:EASYPAT_PWSH_PATH = Join-Path $PSHOME 'pwsh.exe'
    Add-Type -AssemblyName PresentationFramework
    $message = "기존 세션 231 → Response → Body → Text의 응답 본문 전체를 복사하세요.`n`nFiddler에서 복사만 한 뒤 확인을 누르세요.`nPowerShell 창에는 내용을 붙여넣지 마세요."
    $null = [System.Windows.MessageBox]::Show($message, 'EasyPAT 출처 검사', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Information)
    $sourceResponse = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($sourceResponse)) { throw 'Response unavailable' }
    $sourceNode = Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'
    $sourceStart = [System.Diagnostics.ProcessStartInfo]::new($sourceNode)
    $sourceStart.ArgumentList.Add((Join-Path $PSScriptRoot '..\src\inspect-document-group-source-response.mjs'))
    $sourceStart.UseShellExecute = $false
    $sourceStart.CreateNoWindow = $true
    $sourceStart.RedirectStandardInput = $true
    $sourceStart.RedirectStandardOutput = $true
    $sourceStart.RedirectStandardError = $true
    $sourceStart.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $sourceProcess = [System.Diagnostics.Process]::Start($sourceStart)
    $sourceStdout = $sourceProcess.StandardOutput.ReadToEndAsync()
    $sourceStderr = $sourceProcess.StandardError.ReadToEndAsync()
    $sourceProcess.StandardInput.Write($sourceResponse)
    $sourceProcess.StandardInput.Close()
    $sourceResponse = $null
    if (-not $sourceProcess.WaitForExit(60000)) { $sourceProcess.Kill(); throw 'Inspection timed out' }
    $sourceOutput = if ($sourceProcess.ExitCode -eq 0) { $sourceStdout.Result } else { $sourceStderr.Result }
    $sourceSummary = $sourceOutput | ConvertFrom-Json
    if ($sourceSummary.serverRequestsPerformed -ne 0 -or $sourceSummary.productionEnabled -ne $false -or
        ($sourceSummary.rawValuesReturned -ne $false -and $sourceSummary.rawRowsReturned -ne $false) -or
        $sourceSummary.status -notmatch '^document-group-source-response-(candidate-(found|not-found)|rejected)$') { throw 'Summary rejected' }
    Write-Output ($sourceSummary | ConvertTo-Json -Depth 6 -Compress)
    exit $sourceProcess.ExitCode
} catch {
    Write-Output '{"status":"document-group-source-response-helper-rejected","rawValuesReturned":false,"serverRequestsPerformed":0,"productionEnabled":false}'
    exit 1
} finally {
    $sourceResponse = $null
    if ($null -ne $sourceProcess) { $sourceProcess.Dispose() }
}
