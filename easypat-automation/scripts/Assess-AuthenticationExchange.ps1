param([ValidateRange(10,60)][int]$TimeoutSeconds=60)
$ErrorActionPreference='Stop'
$exchangeRequest=$null;$exchangeResponse=$null;$exchangeProcess=$null;$exchangeInput=$null
try{
    $exchangeRequest=Get-Clipboard -Raw
    if($exchangeRequest -notmatch '(?m)^Key=connection; Value=EASYPAT_S_SSPAT\r?$'){throw 'Expected Fiddler request form data'}
    $continuity=Get-Content -Raw (Join-Path $PSScriptRoot '..\config\protocol-observations\authentication-cookie-continuity.json') | ConvertFrom-Json
    if($continuity.cookieName -ne 'JSESSIONID' -or $continuity.equal -ne $true -or $continuity.valuesIncluded -ne $false){throw 'Cookie continuity evidence missing'}
    Write-Output '{"status":"waiting-for-response-body","sensitiveValuesIncluded":false}'
    $deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do{
        Start-Sleep -Milliseconds 250
        $exchangeResponse=Get-Clipboard -Raw
        if([string]::Equals($exchangeRequest,$exchangeResponse,[System.StringComparison]::Ordinal)){continue}
        if($exchangeResponse -notmatch '^----------[A-Za-z0-9-]+\r?\nContent-Type: text/resultset'){continue}
        $boundary=([regex]::Match($exchangeResponse,'^(----------[A-Za-z0-9-]+)')).Groups[1].Value
        $exchangeInput=[pscustomobject]@{requestCopied=$exchangeRequest;responseText=$exchangeResponse;responseContentType="multipart/mixed; boundary=$boundary;charset=UTF-8";cookieContinuity=$true} | ConvertTo-Json -Compress
        $info=[System.Diagnostics.ProcessStartInfo]::new('node')
        $info.ArgumentList.Add((Join-Path $PSScriptRoot '..\src\inspect-auth-exchange.mjs'))
        $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardInputEncoding=[System.Text.UTF8Encoding]::new($false)
        $exchangeProcess=[System.Diagnostics.Process]::Start($info)
        $exchangeProcess.StandardInput.Write($exchangeInput);$exchangeProcess.StandardInput.Close()
        $summary=$exchangeProcess.StandardOutput.ReadToEnd();$null=$exchangeProcess.StandardError.ReadToEnd();$exchangeProcess.WaitForExit()
        if($exchangeProcess.ExitCode -ne 0){throw 'Exchange inspection rejected'}
        $validated=$summary|ConvertFrom-Json
        if($validated.sensitiveValuesIncluded -ne $false -or $validated.executable -ne $false){throw 'Invalid summary'}
        if([string]::Equals((Get-Clipboard -Raw),$exchangeResponse,[System.StringComparison]::Ordinal)){Set-Clipboard -Value '[EasyPAT authentication exchange inspection complete]'}
        Write-Output $summary;exit 0
    }while([DateTime]::UtcNow -lt $deadline)
    throw 'Timed out'
}catch{
    Write-Output '{"status":"rejected","reason":"authentication exchange inspection failed","sensitiveValuesIncluded":false,"executable":false}'
    exit 1
}finally{
    $exchangeRequest=$null;$exchangeResponse=$null;$exchangeInput=$null;$summary=$null;$validated=$null
    if($null-ne$exchangeProcess){$exchangeProcess.Dispose()}
}
