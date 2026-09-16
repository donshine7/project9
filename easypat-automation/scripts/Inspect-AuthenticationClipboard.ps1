param(
    [Parameter(Mandatory = $true)][ValidateSet('sql','cookie','binding','batch','batch-binding','template')][string]$Mode,
    [switch]$ClearCopiedValue
)
$ErrorActionPreference = 'Stop'
$authInspectionProcess = $null
$authCopiedText = $null
try {
    $authCopiedText = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($authCopiedText)) { throw 'Empty clipboard' }
    $authInspectionInfo = [System.Diagnostics.ProcessStartInfo]::new('node')
    $authInspectionInfo.ArgumentList.Add((Join-Path $PSScriptRoot '..\src\inspect-auth-shape.mjs'))
    $authInspectionInfo.ArgumentList.Add($Mode)
    $authInspectionInfo.UseShellExecute = $false
    $authInspectionInfo.CreateNoWindow = $true
    $authInspectionInfo.RedirectStandardInput = $true
    $authInspectionInfo.RedirectStandardOutput = $true
    $authInspectionInfo.RedirectStandardError = $true
    $authInspectionInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $authInspectionProcess = [System.Diagnostics.Process]::Start($authInspectionInfo)
    $authInspectionProcess.StandardInput.Write($authCopiedText)
    $authInspectionProcess.StandardInput.Close()
    $authShapeSummary = $authInspectionProcess.StandardOutput.ReadToEnd()
    $null = $authInspectionProcess.StandardError.ReadToEnd()
    $authInspectionProcess.WaitForExit()
    if ($authInspectionProcess.ExitCode -ne 0) { throw 'Inspection rejected' }
    $authValidatedSummary = $authShapeSummary | ConvertFrom-Json
    if ($authValidatedSummary.executable -ne $false -or $authValidatedSummary.valuesIncluded -ne $false) { throw 'Invalid summary' }
    if ($ClearCopiedValue -and [string]::Equals((Get-Clipboard -Raw), $authCopiedText, [System.StringComparison]::Ordinal)) {
        Set-Clipboard -Value '[EasyPAT authentication shape inspection complete]'
    }
    Write-Output $authShapeSummary
} catch {
    Write-Output '{"status":"rejected","executable":false,"reason":"authentication clipboard inspection failed"}'
    exit 1
} finally {
    $authCopiedText = $null
    if ($null -ne $authInspectionProcess) { $authInspectionProcess.Dispose() }
}
