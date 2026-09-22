param()
$ErrorActionPreference = 'Stop'
$requestText = $null
$requestProcess = $null
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }
    $env:EASYPAT_PWSH_PATH = Join-Path $PSHOME 'pwsh.exe'
    Add-Type -AssemblyName PresentationFramework
    $message = "기존 세션 231을 선택하세요.`n위쪽 Request → Body → Form-Data를 누르세요.`nKey가 sql인 행의 Value 셀을 한 번 클릭해 선택한 뒤 Ctrl+C를 한 번 누르세요.`nText 화면, 다른 셀, 전체 복사 아이콘은 사용하지 마세요.`nPowerShell 창에는 붙여넣지 마세요.`n`n복사 후 이 확인창의 확인을 누르세요."
    $null = [System.Windows.MessageBox]::Show($message, 'EasyPAT 요청 출처 검사', [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Information)
    $requestText = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($requestText)) { throw 'Request unavailable' }
    $requestNode = Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'
    $requestStart = [System.Diagnostics.ProcessStartInfo]::new($requestNode)
    $requestStart.ArgumentList.Add((Join-Path $PSScriptRoot '..\src\capture-document-group-source-request.mjs'))
    $requestStart.UseShellExecute = $false
    $requestStart.CreateNoWindow = $true
    $requestStart.RedirectStandardInput = $true
    $requestStart.RedirectStandardOutput = $true
    $requestStart.RedirectStandardError = $true
    $requestStart.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $requestProcess = [System.Diagnostics.Process]::Start($requestStart)
    $requestStdout = $requestProcess.StandardOutput.ReadToEndAsync()
    $requestStderr = $requestProcess.StandardError.ReadToEndAsync()
    $requestProcess.StandardInput.Write($requestText)
    $requestProcess.StandardInput.Close()
    $requestText = $null
    if (-not $requestProcess.WaitForExit(60000)) { $requestProcess.Kill(); throw 'Inspection timed out' }
    $requestOutput = if ($requestProcess.ExitCode -eq 0) { $requestStdout.Result } else { $requestStderr.Result }
    $requestSummary = $requestOutput | ConvertFrom-Json
    if ($requestSummary.serverRequestsPerformed -ne 0 -or $requestSummary.productionEnabled -ne $false -or
        $requestSummary.rawValuesReturned -ne $false -or $requestSummary.status -notmatch '^document-group-source-request-(captured|rejected)$') { throw 'Summary rejected' }
    Write-Output ($requestSummary | ConvertTo-Json -Depth 6 -Compress)
    exit $requestProcess.ExitCode
} catch {
    Write-Output '{"status":"document-group-source-request-helper-rejected","rawValuesReturned":false,"serverRequestsPerformed":0,"productionEnabled":false}'
    exit 1
} finally {
    $requestText = $null
    if ($null -ne $requestProcess) { $requestProcess.Dispose() }
}
