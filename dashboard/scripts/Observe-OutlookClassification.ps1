param(
    [Parameter(Mandatory = $true)][datetime]$From,
    [Parameter(Mandatory = $true)][datetime]$To,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(1, 5000)][int]$MaxItems = 1000
)

$ErrorActionPreference = 'Stop'
$targetStoreDisplayName = 'jtjang@sspat.net'
if ($To -le $From) { throw '종료 시각은 시작 시각보다 뒤여야 합니다.' }

$skipFolderNames = @(
    '보낸 편지함', '삭제된 항목', '지운 편지함', '정크 메일', '스팸',
    '임시 보관함', '보낼 편지함', '동기화 문제', 'RSS 피드'
)
$script:records = New-Object System.Collections.Generic.List[object]
$script:folders = New-Object System.Collections.Generic.List[object]
$script:errors = New-Object System.Collections.Generic.List[object]
$fromUtc = $From.ToUniversalTime()
$toUtc = $To.ToUniversalTime()

function Get-AddressEntrySmtpAddress($entry) {
    try {
        if ($null -eq $entry) { return $null }
        $address = [string]$entry.Address
        if ([string]$entry.Type -eq 'EX') {
            $exchangeUser = $entry.GetExchangeUser()
            if ($null -ne $exchangeUser -and $exchangeUser.PrimarySmtpAddress) {
                $address = [string]$exchangeUser.PrimarySmtpAddress
            }
            if ($address.IndexOf('@') -lt 0) {
                try {
                    $address = [string]$entry.PropertyAccessor.GetProperty(
                        'http://schemas.microsoft.com/mapi/proptag/0x39FE001E'
                    )
                } catch {}
            }
        }
        return $address.Trim().ToLowerInvariant()
    } catch { return $null }
}

function Get-SmtpAddress($mail) {
    try {
        $address = [string]$mail.SenderEmailAddress
        if ([string]$mail.SenderEmailType -eq 'EX' -or $address.IndexOf('@') -lt 0) {
            $resolved = Get-AddressEntrySmtpAddress $mail.Sender
            if ($resolved) { $address = $resolved }
        }
        return $address.Trim().ToLowerInvariant()
    } catch { return $null }
}

function Get-RecipientAddresses($mail) {
    $addresses = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($recipient in $mail.Recipients) {
            if ([int]$recipient.Type -ne 1 -and [int]$recipient.Type -ne 2) { continue }
            $address = Get-AddressEntrySmtpAddress $recipient.AddressEntry
            if (-not $address) {
                try { $address = ([string]$recipient.Address).Trim().ToLowerInvariant() } catch {}
            }
            $addresses.Add([pscustomobject]@{
                type = if ([int]$recipient.Type -eq 1) { 'to' } else { 'cc' }
                name = [string]$recipient.Name
                address = $address
            })
        }
    } catch {}
    return $addresses.ToArray()
}

function Test-SkippedFolder([string]$name) {
    foreach ($skipName in $skipFolderNames) {
        if ([string]::Equals($name, $skipName, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Observe-MailFolder($folder) {
    if ($script:records.Count -ge $MaxItems) { return }
    $folderName = [string]$folder.Name
    if (Test-SkippedFolder $folderName) { return }
    if ([int]$folder.DefaultItemType -ne 0) { return }

    $items = $folder.Items
    $itemsSortedByReceivedTime = $false
    try {
        $items.Sort('[ReceivedTime]', $true)
        $itemsSortedByReceivedTime = $true
    } catch {}
    $folderObserved = 0
    $folderTotal = 0
    try { $folderTotal = [int]$items.Count } catch {}
    foreach ($item in $items) {
        if ($script:records.Count -ge $MaxItems) { break }
        try {
            if ([int]$item.Class -ne 43) { continue }
            $received = [datetime]($item.ReceivedTime)
            $receivedUtc = $received.ToUniversalTime()
            if ($receivedUtc -lt $fromUtc) {
                if ($itemsSortedByReceivedTime) { break }
                continue
            }
            if ($receivedUtc -ge $toUtc) { continue }

            $created = $null
            $modified = $null
            try { $created = [datetime]($item.CreationTime) } catch {}
            try { $modified = [datetime]($item.LastModificationTime) } catch {}
            $internetMessageId = $null
            try {
                $internetMessageId = [string]$item.PropertyAccessor.GetProperty(
                    'http://schemas.microsoft.com/mapi/proptag/0x1035001E'
                )
            } catch {}
            $body = [string]$item.Body
            if ($body.Length -gt 100000) { $body = $body.Substring(0, 100000) }
            $script:records.Add([pscustomobject]@{
                entryId = [string]$item.EntryID
                internetMessageId = $internetMessageId
                conversationId = [string]$item.ConversationID
                folderName = $folderName
                folderPath = [string]$folder.FolderPath
                subject = [string]$item.Subject
                senderName = [string]$item.SenderName
                senderEmail = Get-SmtpAddress $item
                recipients = @(Get-RecipientAddresses $item)
                to = [string]$item.To
                cc = [string]$item.CC
                receivedAt = $receivedUtc.ToString('o')
                creationAt = if ($null -ne $created) { $created.ToUniversalTime().ToString('o') } else { $null }
                modifiedAt = if ($null -ne $modified) { $modified.ToUniversalTime().ToString('o') } else { $null }
                unread = [bool]$item.UnRead
                body = $body
            })
            $folderObserved++
        } catch {
            if ($script:errors.Count -lt 50) {
                $script:errors.Add([pscustomobject]@{
                    folderPath = [string]$folder.FolderPath
                    message = $_.Exception.Message
                })
            }
        }
    }
    $script:folders.Add([pscustomobject]@{
        name = $folderName
        path = [string]$folder.FolderPath
        totalItems = $folderTotal
        observedItems = $folderObserved
    })
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

$root = $targetStore.GetRootFolder()
foreach ($folder in $root.Folders) { Observe-MailFolder $folder }

$result = [pscustomobject]@{
    store = $targetStoreDisplayName
    from = $fromUtc.ToString('o')
    to = $toUtc.ToString('o')
    observedAt = [datetime]::UtcNow.ToString('o')
    folders = $script:folders.ToArray()
    records = $script:records.ToArray()
    errors = $script:errors.ToArray()
    truncated = ($script:records.Count -ge $MaxItems)
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText(
    [IO.Path]::GetFullPath($OutputPath),
    ($result | ConvertTo-Json -Depth 7),
    $utf8NoBom
)

[pscustomobject]@{
    ok = $true
    observedCount = $script:records.Count
    folderCount = $script:folders.Count
    errorCount = $script:errors.Count
    truncated = ($script:records.Count -ge $MaxItems)
    outputPath = [IO.Path]::GetFullPath($OutputPath)
} | ConvertTo-Json -Compress
