# Run with PowerShell 7. This helper inspects existing capture 245 only;
# it never sends an EasyPAT request or prints clipboard contents.
param()
$ErrorActionPreference = 'Stop'
$groupInspectionProcess = $null
$groupCopiedText = $null

function Invoke-GroupClipboardInspection([string]$EntryPoint, [string]$ExpectedStatus) {
    $groupCopiedText = $null
    $groupInspectionProcess = $null
    try {
        $groupCopiedText = Get-Clipboard -Raw
        if ([string]::IsNullOrWhiteSpace($groupCopiedText) -or
            [System.Text.Encoding]::UTF8.GetByteCount($groupCopiedText) -gt 2097152) { throw 'Input rejected' }
        $groupNodePath = Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'
        if (-not (Test-Path -LiteralPath $groupNodePath -PathType Leaf)) { throw 'Runtime unavailable' }
        $groupStart = [System.Diagnostics.ProcessStartInfo]::new($groupNodePath)
        $groupStart.ArgumentList.Add((Join-Path $PSScriptRoot $EntryPoint))
        $groupStart.UseShellExecute = $false
        $groupStart.CreateNoWindow = $true
        $groupStart.RedirectStandardInput = $true
        $groupStart.RedirectStandardOutput = $true
        $groupStart.RedirectStandardError = $true
        $groupStart.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
        $groupStart.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $groupStart.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
        $groupInspectionProcess = [System.Diagnostics.Process]::Start($groupStart)
        $groupStdoutTask = $groupInspectionProcess.StandardOutput.ReadToEndAsync()
        $groupStderrTask = $groupInspectionProcess.StandardError.ReadToEndAsync()
        # Write, not WriteLine: preserve the resultset framing exactly.
        $groupInspectionProcess.StandardInput.Write($groupCopiedText)
        $groupInspectionProcess.StandardInput.Close()
        $groupCopiedText = $null
        if (-not $groupInspectionProcess.WaitForExit(60000)) {
            $groupInspectionProcess.Kill()
            throw 'Inspection timed out'
        }
        $groupOutput = if ($groupInspectionProcess.ExitCode -eq 0) { $groupStdoutTask.Result } else { $groupStderrTask.Result }
        $groupSummary = $groupOutput | ConvertFrom-Json
        if ($groupSummary.serverRequestsPerformed -ne 0 -or $groupSummary.productionEnabled -ne $false -or
            ($groupSummary.rawValuesReturned -ne $false -and $groupSummary.rawRowsReturned -ne $false) -or
            $groupSummary.status -notmatch '^document-group-intermediate-(request|response)-[a-z-]+$') { throw 'Summary rejected' }
        Write-Host ($groupSummary | ConvertTo-Json -Depth 6 -Compress)
        if ($groupInspectionProcess.ExitCode -ne 0 -or $groupSummary.status -notmatch $ExpectedStatus) { return $false }
        return $true
    } catch {
        Write-Host '{"status":"document-group-clipboard-helper-rejected","rawValuesReturned":false,"serverRequestsPerformed":0,"productionEnabled":false}'
        return $false
    } finally {
        $groupCopiedText = $null
        if ($null -ne $groupInspectionProcess) { $groupInspectionProcess.Dispose() }
    }
}

function Wait-ForFiddlerCopy([string]$Instruction) {
    try {
        Add-Type -AssemblyName PresentationFramework
        $message = $Instruction + "`n`nFiddler에서 복사만 한 뒤 이 확인 창의 확인을 누르세요." +
            "`nPowerShell 창에는 내용을 붙여넣지 마세요."
        $null = [System.Windows.MessageBox]::Show(
            $message,
            'EasyPAT 캡처 검사',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Information
        )
    } catch {
        Write-Host $Instruction
        $confirmation = Read-Host 'Fiddler에서 복사한 뒤, 내용을 붙여넣지 말고 Enter만 누르세요'
        if (-not [string]::IsNullOrEmpty($confirmation)) { throw 'Terminal paste rejected' }
    }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 required' }
    $env:EASYPAT_PWSH_PATH = Join-Path $PSHOME 'pwsh.exe'
    Wait-ForFiddlerCopy '1/2 Fiddler 기존 세션 245 → Request → Body → Text에서 요청 본문 전체를 복사하세요. 쿠키나 Headers/Raw 전체가 아닌 Body만 복사합니다. EasyPAT을 다시 조작할 필요는 없습니다.'
    if (-not (Invoke-GroupClipboardInspection '..\src\capture-document-group-intermediate-request.mjs' '^document-group-intermediate-request-captured$')) { exit 1 }
    Wait-ForFiddlerCopy '2/2 같은 세션 245 → Response → Body → Text에서 응답 본문 전체를 복사하세요.'
    if (-not (Invoke-GroupClipboardInspection '..\src\inspect-document-group-intermediate-response.mjs' '^document-group-intermediate-response-link-(found|not-found)$')) { exit 1 }
} catch {
    Write-Host '{"status":"document-group-clipboard-helper-rejected","rawValuesReturned":false,"serverRequestsPerformed":0,"productionEnabled":false}'
    exit 1
}
