param(
    [Parameter(Mandatory = $true)][datetime]$From,
    [Parameter(Mandatory = $true)][datetime]$To,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(1, 20000)][int]$MaxItems = 5000
)

$ErrorActionPreference = 'Stop'
$targetStoreDisplayName = 'jtjang@sspat.net'

if ($To -le $From) { throw '종료 시각은 시작 시각보다 뒤여야 합니다.' }

$excludedFolderNames = @('대한변리사회', '결재', '해외 출원 자동 안내', '과제 자동 안내')
$script:records = New-Object System.Collections.Generic.List[object]
$script:visitedFolders = New-Object System.Collections.Generic.List[string]
$script:excludedFolders = New-Object System.Collections.Generic.List[string]

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
            if ($null -ne $exchangeUser -and $exchangeUser.PrimarySmtpAddress) { return [string]$exchangeUser.PrimarySmtpAddress }
        }
        return [string]$mail.SenderEmailAddress
    } catch { return $null }
}

function Get-RecipientSnapshots($mail) {
    $snapshots = New-Object System.Collections.Generic.List[object]
    foreach ($recipient in $mail.Recipients) {
        try {
            $kind = switch ([int]$recipient.Type) { 1 { 'to' } 2 { 'cc' } 3 { 'bcc' } default { 'unknown' } }
            $smtp = $null
            $addressEntry = $recipient.AddressEntry
            if ($null -ne $addressEntry) {
                try {
                    if ([string]$addressEntry.Type -eq 'EX') {
                        $exchangeUser = $addressEntry.GetExchangeUser()
                        if ($null -ne $exchangeUser -and $exchangeUser.PrimarySmtpAddress) { $smtp = [string]$exchangeUser.PrimarySmtpAddress }
                        if (-not $smtp) {
                            $exchangeList = $addressEntry.GetExchangeDistributionList()
                            if ($null -ne $exchangeList -and $exchangeList.PrimarySmtpAddress) { $smtp = [string]$exchangeList.PrimarySmtpAddress }
                        }
                        if (-not $smtp) { try { $smtp = [string]$addressEntry.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x39FE001E') } catch {} }
                    } elseif ($addressEntry.Address) { $smtp = [string]$addressEntry.Address }
                } catch {}
            }
            $snapshots.Add([pscustomobject]@{
                type = $kind
                displayName = [string]$recipient.Name
                smtpAddress = if ($smtp) { $smtp.Trim().ToLowerInvariant() } else { $null }
                resolved = [bool]$recipient.Resolved
            })
        } catch {
            # 확인할 수 없는 개별 수신자는 누락시키되 문자열 To/CC는 별도로 보존한다.
        }
    }
    return $snapshots.ToArray()
}

function Read-MailFolder($folder, [string]$direction) {
    if ($script:records.Count -ge $MaxItems) { return }
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
        if ($script:records.Count -ge $MaxItems) { break }
        try {
            if ([int]$item.Class -ne 43) { continue }
            $mailAt = if ($direction -eq 'sent') { [datetime]$item.SentOn } else { [datetime]$item.ReceivedTime }
            if ($mailAt -ge $To) { continue }
            if ($mailAt -lt $From) { break }
            $internetMessageId = $null
            try { $internetMessageId = [string]$item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x1035001E') } catch {}
            $body = [string]$item.Body
            if ($body.Length -gt 100000) { $body = $body.Substring(0, 100000) }
            $script:records.Add([pscustomobject]@{
                entryId = [string]$item.EntryID
                internetMessageId = $internetMessageId
                conversationId = [string]$item.ConversationID
                folderPath = [string]$folder.FolderPath
                direction = $direction
                subject = [string]$item.Subject
                senderName = [string]$item.SenderName
                senderEmail = Get-SmtpAddress $item
                to = [string]$item.To
                cc = [string]$item.CC
                storeDisplayName = $targetStoreDisplayName
                recipients = Get-RecipientSnapshots $item
                mailAt = $mailAt.ToUniversalTime().ToString('o')
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
    if ([string]::Equals([string]$store.DisplayName, $targetStoreDisplayName, [StringComparison]::OrdinalIgnoreCase)) { $targetStore = $store; break }
}
if ($null -eq $targetStore) { throw "Outlook에서 대상 메일 저장소를 찾을 수 없습니다: $targetStoreDisplayName" }

$sentFolder = $targetStore.GetDefaultFolder(5)
Read-MailFolder $sentFolder 'sent'
$rootFolder = $targetStore.GetRootFolder()
foreach ($topFolder in $rootFolder.Folders) {
    if ([string]$topFolder.EntryID -eq [string]$sentFolder.EntryID) { continue }
    # 메일 폴더만 읽는다. 일정·연락처·작업 폴더는 열거하지 않는다.
    if ([int]$topFolder.DefaultItemType -ne 0) { continue }
    $name = [string]$topFolder.Name
    if ($name -match '^(삭제|지운|정크|스팸|임시|보낼|동기화 문제|RSS)') { continue }
    Read-MailFolder $topFolder 'received'
}

$result = [pscustomobject]@{
    from = $From.ToUniversalTime().ToString('o')
    to = $To.ToUniversalTime().ToString('o')
    folders = $script:visitedFolders.ToArray()
    excludedFolders = $script:excludedFolders.ToArray()
    records = $script:records.ToArray()
    truncated = ($script:records.Count -ge $MaxItems)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), ($result | ConvertTo-Json -Depth 5), $utf8NoBom)
[pscustomobject]@{ ok = $true; count = $script:records.Count; outputPath = [IO.Path]::GetFullPath($OutputPath) } | ConvertTo-Json -Compress
