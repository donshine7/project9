[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$targetName = 'EasyPAT/Automation'
$credentialBlob = [IntPtr]::Zero
$existingCredential = [IntPtr]::Zero
$password = $null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EasyPatCredentialWriter {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Credential {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool Write(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint="CredFree")]
    public static extern void Free(IntPtr credential);
}
'@

try {
    if ([EasyPatCredentialWriter]::Read($targetName, 1, 0, [ref]$existingCredential)) {
        throw 'EasyPAT credential already exists; this script will not overwrite it.'
    }
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) {
        throw 'Unable to check the existing EasyPAT credential.'
    }

    $username = Read-Host 'EasyPAT username'
    if ([string]::IsNullOrEmpty($username) -or $username.Length -gt 128 -or $username -match '[^\x20-\x7e]') {
        throw 'Username is outside the currently verified input range.'
    }

    $password = Read-Host 'EasyPAT password' -AsSecureString
    $credentialBlob = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    $blobSize = [Runtime.InteropServices.Marshal]::ReadInt32($credentialBlob, -4)
    if ($blobSize -lt 2 -or $blobSize -gt 512 -or $blobSize % 2 -ne 0) {
        throw 'Password is outside the currently verified input range.'
    }
    for ($offset = 0; $offset -lt $blobSize; $offset += 2) {
        $codeUnit = [Runtime.InteropServices.Marshal]::ReadInt16($credentialBlob, $offset)
        if ($codeUnit -lt 0x20 -or $codeUnit -gt 0x7e) {
            throw 'Password is outside the currently verified input range.'
        }
    }

    $credential = [EasyPatCredentialWriter+Credential]::new()
    $credential.Type = 1
    $credential.TargetName = $targetName
    $credential.Comment = 'EasyPAT local HTTPS automation'
    $credential.BlobSize = $blobSize
    $credential.Blob = $credentialBlob
    $credential.Persist = 2
    $credential.UserName = $username
    if (-not [EasyPatCredentialWriter]::Write([ref]$credential, 0)) {
        throw 'Credential registration failed.'
    }

    [Console]::Out.WriteLine((@{
        stored = $true
        target = $targetName
        passwordDisplayed = $false
        overwritePerformed = $false
    } | ConvertTo-Json -Compress))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    if ($existingCredential -ne [IntPtr]::Zero) { [EasyPatCredentialWriter]::Free($existingCredential) }
    if ($credentialBlob -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialBlob) }
    if ($null -ne $password) { $password.Dispose() }
    $credential = $null
    $username = $null
}
