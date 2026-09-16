param([ValidateRange(10,60)][int]$TimeoutSeconds=45)
$ErrorActionPreference='Stop'
$cookieFirst=$null
$cookieSecond=$null
try {
    $cookieFirst=Get-Clipboard -Raw
    $issuedMatches=[regex]::Matches($cookieFirst,'(?im)^(?:Key[=:] *)?Set-Cookie(?:: *|; Value[=:] *)JSESSIONID=([^;\r\n]+)(?:;[^\r\n]*)?\r?$')
    if($issuedMatches.Count -ne 1){throw 'Expected one issued cookie'}
    $issuedValue=$issuedMatches[0].Groups[1].Value
    $cookieDeadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    Write-Output '{"status":"waiting-for-request-headers","valuesIncluded":false}'
    do {
        Start-Sleep -Milliseconds 250
        $cookieSecond=Get-Clipboard -Raw
        if([string]::Equals($cookieFirst,$cookieSecond,[System.StringComparison]::Ordinal)){continue}
        $requestHeaders=[regex]::Matches($cookieSecond,'(?im)^(?:Key[=:] *)?Cookie(?:: *|; Value[=:] *)([^\r\n]+)\r?$')
        if($requestHeaders.Count -ne 1){continue}
        $requestCookies=[regex]::Matches($requestHeaders[0].Groups[1].Value,'(?:^|;\s*)JSESSIONID=([^;\r\n]+)')
        if($requestCookies.Count -ne 1){throw 'Expected one request cookie'}
        $same=[string]::Equals($issuedValue,$requestCookies[0].Groups[1].Value,[System.StringComparison]::Ordinal)
        if([string]::Equals((Get-Clipboard -Raw),$cookieSecond,[System.StringComparison]::Ordinal)){
            Set-Clipboard -Value '[EasyPAT cookie comparison complete]'
        }
        [pscustomobject]@{status='compared';cookieName='JSESSIONID';equal=$same;valuesIncluded=$false;authenticatedSessionVerified=$false;serverRequestsSent=0} | ConvertTo-Json -Compress
        exit 0
    }while([DateTime]::UtcNow -lt $cookieDeadline)
    throw 'Timed out'
}catch{
    Write-Output '{"status":"rejected","valuesIncluded":false,"reason":"cookie comparison failed"}'
    exit 1
}finally{
    $cookieFirst=$null; $cookieSecond=$null; $issuedValue=$null; $issuedMatches=$null; $requestHeaders=$null; $requestCookies=$null
}
