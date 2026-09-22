param(
    [Parameter(Mandatory = $true)][datetime]$From,
    [Parameter(Mandatory = $true)][datetime]$To,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string[]]$Terms,
    [ValidateRange(1, 5000)][int]$MaxMatches = 1000,
    [switch]$IgnoreDateRange
)

$ErrorActionPreference = 'Stop'
$targetStoreDisplayName = 'jtjang@sspat.net'

if ($To -le $From) { throw '종료 시각은 시작 시각보다 뒤여야 합니다.' }
if ($Terms.Count -eq 0) { throw '검색어를 하나 이상 지정해야 합니다.' }

$excludedFolderNames = @('대한변리사회', '결재', '해외 출원 자동 안내', '과제 자동 안내')
$script:evidenceRecords = New-Object System.Collections.Generic.List[object]
$script:visitedFolders = New-Object System.Collections.Generic.List[string]
$script:excludedFolders = New-Object System.Collections.Generic.List[string]
$script:scannedCount = 0
$script:enumeratedCount = 0

function Test-ExcludedFolder([string]$name) {
    foreach ($excluded in $excludedFolderNames) {
        if ($name -like "*$excluded*") { return $true }
    }
    return $false
}

function Get-SmtpAddress($mail) {
    try {
        if ($mail.SenderEmailType -eq 'EX') {
            $exchangeUser = $mail.Sender.GetExchangeUser()
            if ($null -ne $exchangeUser -and $exchangeUser.PrimarySmtpAddress) {
                return [string]$exchangeUser.PrimarySmtpAddress
            }
        }
        return [string]$mail.SenderEmailAddress
    } catch { return $null }
}

function Find-MatchedTerms([string]$text) {
    $found = New-Object System.Collections.Generic.List[string]
    foreach ($term in $Terms) {
        if ($text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $found.Add($term)
        }
    }
    return $found.ToArray()
}

function Read-MailFolder($folder, [string]$direction) {
    if ($script:evidenceRecords.Count -ge $MaxMatches) { return }
    $folderName = [string]$folder.Name
    if (Test-ExcludedFolder $folderName) {
        $script:excludedFolders.Add([string]$folder.FolderPath)
        return
    }

    $script:visitedFolders.Add([string]$folder.FolderPath)
    $dateProperty = if ($direction -eq 'sent') { '[SentOn]' } else { '[ReceivedTime]' }
    $items = $folder.Items
    $items.Sort($dateProperty, $true)

    foreach ($item in $items) {
        if ($script:evidenceRecords.Count -ge $MaxMatches) { break }
        try {
            if ([int]$item.Class -ne 43) { continue }
            $script:enumeratedCount++
            $mailAt = $null
            try {
                $mailAt = if ($direction -eq 'sent') { [datetime]$item.SentOn } else { [datetime]$item.ReceivedTime }
            } catch {}
            if (-not $IgnoreDateRange) {
                if ($null -eq $mailAt) { continue }
                if ($mailAt -ge $To) { continue }
                # Outlook 폴더/뷰별 정렬 결과가 항상 단조롭다고 가정하지 않는다.
                if ($mailAt -lt $From) { continue }
            }

            $script:scannedCount++
            $subject = [string]$item.Subject
            $senderName = [string]$item.SenderName
            $senderEmail = Get-SmtpAddress $item
            $to = [string]$item.To
            $cc = [string]$item.CC
            $body = [string]$item.Body
            $searchText = "$subject`n$senderName`n$senderEmail`n$to`n$cc`n$body"
            $matchedTerms = @(Find-MatchedTerms $searchText)
            if ($matchedTerms.Count -eq 0) { continue }

            $internetMessageId = $null
            try {
                $internetMessageId = [string]$item.PropertyAccessor.GetProperty(
                    'http://schemas.microsoft.com/mapi/proptag/0x1035001E'
                )
            } catch {}
            if ($body.Length -gt 100000) { $body = $body.Substring(0, 100000) }

            $script:evidenceRecords.Add([pscustomobject]@{
                entryId = [string]$item.EntryID
                internetMessageId = $internetMessageId
                conversationId = [string]$item.ConversationID
                folderPath = [string]$folder.FolderPath
                direction = $direction
                subject = $subject
                senderName = $senderName
                senderEmail = $senderEmail
                to = $to
                cc = $cc
                mailAt = if ($null -ne $mailAt) { $mailAt.ToUniversalTime().ToString('o') } else { $null }
                matchedTerms = $matchedTerms
                body = $body
            })
        } catch {
            # 손상되었거나 지원하지 않는 개별 항목은 건너뛰며 Outlook 항목은 변경하지 않는다.
        }
    }

    foreach ($child in $folder.Folders) { Read-MailFolder $child $direction }
}

$outputDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath))
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace('MAPI')
$targetStore = $null
foreach ($store in $namespace.Stores) {
    if ([string]::Equals([string]$store.DisplayName, $targetStoreDisplayName, [StringComparison]::OrdinalIgnoreCase)) {
        $targetStore = $store
        break
    }
}
if ($null -eq $targetStore) { throw "Outlook에서 대상 메일 저장소를 찾을 수 없습니다: $targetStoreDisplayName" }

$sentFolder = $targetStore.GetDefaultFolder(5)
Read-MailFolder $sentFolder 'sent'
$rootFolder = $targetStore.GetRootFolder()
foreach ($topFolder in $rootFolder.Folders) {
    if ([string]$topFolder.EntryID -eq [string]$sentFolder.EntryID) { continue }
    if ([int]$topFolder.DefaultItemType -ne 0) { continue }
    $name = [string]$topFolder.Name
    if ($name -match '^(삭제|지운|정크|스팸|임시|보낼|동기화 문제|RSS)') { continue }
    Read-MailFolder $topFolder 'received'
}

$result = [pscustomobject]@{
    from = $From.ToUniversalTime().ToString('o')
    to = $To.ToUniversalTime().ToString('o')
    terms = $Terms
    ignoredDateRange = [bool]$IgnoreDateRange
    scannedCount = $script:scannedCount
    enumeratedCount = $script:enumeratedCount
    folders = $script:visitedFolders.ToArray()
    excludedFolders = $script:excludedFolders.ToArray()
    records = $script:evidenceRecords.ToArray()
    truncated = ($script:evidenceRecords.Count -ge $MaxMatches)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText(
    [IO.Path]::GetFullPath($OutputPath),
    ($result | ConvertTo-Json -Depth 6),
    $utf8NoBom
)

[pscustomobject]@{
    ok = $true
    scannedCount = $script:scannedCount
    enumeratedCount = $script:enumeratedCount
    matchCount = $script:evidenceRecords.Count
    outputPath = [IO.Path]::GetFullPath($OutputPath)
    truncated = ($script:evidenceRecords.Count -ge $MaxMatches)
} | ConvertTo-Json -Compress
