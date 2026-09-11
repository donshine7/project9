[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://127\.0\.0\.1(?::\d+)?/')]
  [string]$Url,

  [ValidateRange(1, 120)]
  [int]$TimeoutSeconds = 60
)

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400) {
      Start-Process $Url
      exit 0
    }
  }
  catch {
    # 서버가 아직 포트를 열지 않았거나 초기 응답을 준비하는 중이다.
  }
  Start-Sleep -Seconds 1
}

exit 1
