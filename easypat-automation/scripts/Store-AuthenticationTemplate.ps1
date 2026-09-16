param([switch]$ClearCopiedValue)
$ErrorActionPreference='Stop';$storeAuthCopied=$null;$storeAuthProcess=$null
try{
  $storeAuthCopied=Get-Clipboard -Raw;if([string]::IsNullOrWhiteSpace($storeAuthCopied)){throw 'Empty clipboard'}
  $info=[System.Diagnostics.ProcessStartInfo]::new('node');$info.ArgumentList.Add((Join-Path $PSScriptRoot '..\src\store-authentication-template.mjs'));$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardInputEncoding=[System.Text.UTF8Encoding]::new($false)
  $storeAuthProcess=[System.Diagnostics.Process]::Start($info);$storeAuthProcess.StandardInput.Write($storeAuthCopied);$storeAuthProcess.StandardInput.Close();$summary=$storeAuthProcess.StandardOutput.ReadToEnd();$null=$storeAuthProcess.StandardError.ReadToEnd();$storeAuthProcess.WaitForExit()
  if($storeAuthProcess.ExitCode-ne 0){throw 'Storage rejected'};$result=$summary|ConvertFrom-Json
  if($result.credentialFree-ne$true-or$result.roundTripVerified-ne$true-or$result.liveEnabled-ne$false){throw 'Invalid result'}
  if($ClearCopiedValue-and[string]::Equals((Get-Clipboard -Raw),$storeAuthCopied,[System.StringComparison]::Ordinal)){Set-Clipboard -Value '[EasyPAT authentication template stored]'}
  Write-Output $summary
}catch{Write-Output '{"status":"rejected","reason":"authentication template storage failed","liveEnabled":false}';exit 1}
finally{$storeAuthCopied=$null;$summary=$null;$result=$null;if($null-ne$storeAuthProcess){$storeAuthProcess.Dispose()}}
