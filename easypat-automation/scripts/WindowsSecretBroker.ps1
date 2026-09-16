param([ValidateSet('Protect','Unprotect','CredentialStatus','ReadCredential')][string]$Operation)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$secretBytes = $null
try {
    if ($Operation -eq 'ReadCredential' -or $Operation -eq 'CredentialStatus') {
        # Only this application-specific generic credential is accessible here.
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EasyPatCredential {
    [StructLayout(LayoutKind.Sequential)]
    public struct Credential {
        public uint Flags, Type;
        public IntPtr TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes, TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint="CredFree")]
    public static extern void Free(IntPtr credential);
}
'@
        $credentialPointer = [IntPtr]::Zero
        if (-not [EasyPatCredential]::Read('EasyPAT/Automation', 1, 0, [ref]$credentialPointer)) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($Operation -eq 'CredentialStatus' -and $nativeError -eq 1168) {
                [Console]::Out.Write((@{available=$false; usernamePresent=$false; passwordPresent=$false} | ConvertTo-Json -Compress))
                return
            }
            throw 'Credential unavailable'
        }
        try {
            $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][EasyPatCredential+Credential])
            if ($credential.BlobSize -eq 0 -or $credential.BlobSize -gt 2560 -or $credential.BlobSize % 2 -ne 0) { throw 'Invalid credential encoding' }
            if ($Operation -eq 'CredentialStatus') {
                [Console]::Out.Write((@{
                    available=$true
                    usernamePresent=($credential.UserName -ne [IntPtr]::Zero)
                    passwordPresent=($credential.BlobSize -gt 0)
                } | ConvertTo-Json -Compress))
                return
            }
            $secretBytes = New-Object byte[] $credential.BlobSize
            [Runtime.InteropServices.Marshal]::Copy($credential.Blob, $secretBytes, 0, $secretBytes.Length)
            $username = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.UserName)
            $password = [System.Text.UnicodeEncoding]::new($false, $false, $true).GetString($secretBytes)
            if ([string]::IsNullOrEmpty($username) -or [string]::IsNullOrEmpty($password)) { throw 'Empty credential' }
            [Console]::Out.Write((@{username=$username; password=$password} | ConvertTo-Json -Compress))
        } finally { [EasyPatCredential]::Free($credentialPointer) }
    } else {
        Add-Type -AssemblyName System.Security
        $inputText = [Console]::In.ReadToEnd()
        if ($inputText.Length -gt 4000000) { throw 'Input too large' }
        $inputData = $inputText | ConvertFrom-Json
        $secretBytes = [Convert]::FromBase64String($inputData.data)
        $entropy = [System.Text.Encoding]::UTF8.GetBytes('EasyPAT.TemplateStore.v1')
        $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        if ($Operation -eq 'Protect') {
            $resultBytes = [System.Security.Cryptography.ProtectedData]::Protect($secretBytes, $entropy, $scope)
        } else {
            $resultBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($secretBytes, $entropy, $scope)
        }
        try { [Console]::Out.Write((@{data=[Convert]::ToBase64String($resultBytes)} | ConvertTo-Json -Compress)) }
        finally { [Array]::Clear($resultBytes, 0, $resultBytes.Length) }
    }
} catch {
    [Console]::Error.Write('WINDOWS_SECRET_OPERATION_FAILED')
    exit 1
} finally {
    if ($null -ne $secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
    $inputText = $null; $inputData = $null; $password = $null; $username = $null
}
