param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('119', '168', '170', '174', '247')]
    [string]$SessionId,
    [ValidateSet('Statement', 'SearchResult', 'DetailKeys', 'ProgressLinkage', 'DocumentShape', 'DocumentEvidence', 'DocumentBroadEvidence', 'DocumentLinkage', 'StoreTemplate')]
    [string]$Mode = 'Statement',
    [switch]$ClearCopiedValue
)

$ErrorActionPreference = 'Stop'
$inspectionProcess = $null
$copiedStatement = $null
try {
    $copiedStatement = Get-Clipboard -Raw
    if ([string]::IsNullOrWhiteSpace($copiedStatement)) { throw 'No copied value' }
    $inspectionInfo = [System.Diagnostics.ProcessStartInfo]::new('node')
    if (($Mode -eq 'SearchResult') -ne ($SessionId -eq '119')) { throw 'Invalid mode/session combination' }
    if (($Mode -eq 'ProgressLinkage') -and ($SessionId -ne '174')) { throw 'Invalid mode/session combination' }
    if (($Mode -eq 'DocumentLinkage') -and ($SessionId -ne '247')) { throw 'Invalid mode/session combination' }
    if (($Mode -eq 'DocumentShape') -and ($SessionId -ne '247')) { throw 'Invalid mode/session combination' }
    if (($Mode -eq 'DocumentEvidence') -and ($SessionId -ne '247')) { throw 'Invalid mode/session combination' }
    if (($Mode -eq 'DocumentBroadEvidence') -and ($SessionId -ne '247')) { throw 'Invalid mode/session combination' }
    $entryPoint = switch ($Mode) {
        'SearchResult' { '..\src\inspect-search-result.mjs' }
        'DetailKeys' { '..\src\inspect-detail-keys.mjs' }
        'ProgressLinkage' { '..\src\inspect-progress-template-linkage.mjs' }
        'DocumentLinkage' { '..\src\inspect-document-template-linkage.mjs' }
        'DocumentShape' { '..\src\inspect-document-template-shape.mjs' }
        'DocumentEvidence' { '..\src\inspect-document-predicate-evidence.mjs' }
        'DocumentBroadEvidence' { '..\src\inspect-document-broad-evidence.mjs' }
        'StoreTemplate' { '..\src\store-copied-template.mjs' }
        default { '..\src\inspect-copied-statement.mjs' }
    }
    $inspectionInfo.ArgumentList.Add((Join-Path $PSScriptRoot $entryPoint))
    $inspectionInfo.ArgumentList.Add($SessionId)
    $inspectionInfo.UseShellExecute = $false
    $inspectionInfo.CreateNoWindow = $true
    $inspectionInfo.RedirectStandardInput = $true
    $inspectionInfo.RedirectStandardOutput = $true
    $inspectionInfo.RedirectStandardError = $true
    $inspectionInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $inspectionProcess = [System.Diagnostics.Process]::Start($inspectionInfo)
    $inspectionProcess.StandardInput.Write($copiedStatement)
    $inspectionProcess.StandardInput.Close()
    $inspectionSummary = $inspectionProcess.StandardOutput.ReadToEnd()
    $inspectionError = $inspectionProcess.StandardError.ReadToEnd()
    $inspectionProcess.WaitForExit()
    if ($inspectionProcess.ExitCode -ne 0) {
        try {
            $safeError = $inspectionError | ConvertFrom-Json
            if ($safeError.status -eq 'rejected' -and $safeError.productionEnabled -eq $false -and
                $safeError.failureStage -match '^[a-z-]+$' -and $safeError.rawValuesReturned -eq $false) {
                Write-Output ($safeError | ConvertTo-Json -Compress)
                exit 1
            }
        } catch { }
        throw 'Inspection rejected'
    }
    $validatedSummary = $inspectionSummary | ConvertFrom-Json
    $summaryDigest = if ($Mode -eq 'SearchResult') { $validatedSummary.valueDigest } else { $validatedSummary.candidateFingerprint }
    if ($validatedSummary.executable -ne $false -or $summaryDigest -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid inspection summary'
    }
    # Only replace the exact inspected clipboard text; leave new user input alone.
    if ($ClearCopiedValue -and [string]::Equals((Get-Clipboard -Raw), $copiedStatement, [System.StringComparison]::Ordinal)) {
        Set-Clipboard -Value '[EasyPAT capture inspection complete]'
    }
    Write-Output $inspectionSummary
} catch {
    Write-Output '{"status":"rejected","reason":"clipboard inspection failed","executable":false}'
    exit 1
} finally {
    $copiedStatement = $null
    if ($null -ne $inspectionProcess) { $inspectionProcess.Dispose() }
}
