[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("credential-get", "credential-set", "credential-delete", "open-url", "protect-path")]
    [string] $Operation,

    [Parameter(Position = 1)]
    [string] $First,

    [Parameter(Position = 2)]
    [string] $Second
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace KingLicenseNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential
    {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static class NativeMethods
    {
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

        [DllImport("advapi32.dll")]
        public static extern void CredFree(IntPtr credential);

        [DllImport("shell32.dll", EntryPoint = "ShellExecuteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr ShellExecute(IntPtr window, string operation, string file, string parameters, string directory, int showCommand);
    }
}
"@

$CredentialTypeGeneric = [UInt32] 1
$CredentialPersistLocalMachine = [UInt32] 2
$ErrorNotFound = 1168

function Get-TargetName([string] $Service, [string] $Account) {
    if ([string]::IsNullOrWhiteSpace($Service) -or [string]::IsNullOrWhiteSpace($Account)) {
        throw "Credential service and account are required."
    }
    if ($Service.Length -gt 160 -or $Account.Length -gt 160) {
        throw "Credential service or account is too long."
    }
    return "KING|$Service|$Account"
}

function Read-EncodedInput {
    $encoded = [Console]::In.ReadLine()
    if ([string]::IsNullOrWhiteSpace($encoded)) {
        throw "Encoded standard input is required."
    }
    try {
        return ,([Convert]::FromBase64String($encoded.Trim()))
    }
    catch {
        throw "Standard input is not valid Base64."
    }
}

function Clear-ByteArray([byte[]] $Bytes) {
    if ($null -ne $Bytes) {
        [Array]::Clear($Bytes, 0, $Bytes.Length)
    }
}

switch ($Operation) {
    "credential-get" {
        $target = Get-TargetName $First $Second
        $pointer = [IntPtr]::Zero
        if (-not [KingLicenseNative.NativeMethods]::CredRead(
            $target,
            $CredentialTypeGeneric,
            0,
            [ref] $pointer
        )) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($nativeError -eq $ErrorNotFound) {
                exit 44
            }
            throw [ComponentModel.Win32Exception]::new($nativeError)
        }

        $bytes = $null
        try {
            $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
                $pointer,
                [type] [KingLicenseNative.Credential]
            )
            $bytes = [byte[]]::new([int] $credential.CredentialBlobSize)
            if ($bytes.Length -gt 0) {
                [Runtime.InteropServices.Marshal]::Copy(
                    $credential.CredentialBlob,
                    $bytes,
                    0,
                    $bytes.Length
                )
            }
            [Console]::Out.WriteLine([Convert]::ToBase64String($bytes))
        }
        finally {
            Clear-ByteArray $bytes
            if ($pointer -ne [IntPtr]::Zero) {
                [KingLicenseNative.NativeMethods]::CredFree($pointer)
            }
        }
    }

    "credential-set" {
        $target = Get-TargetName $First $Second
        $bytes = Read-EncodedInput
        if ($bytes.Length -gt 2560) {
            Clear-ByteArray $bytes
            throw "Credential exceeds the Windows generic-credential limit."
        }

        $blob = [IntPtr]::Zero
        try {
            if ($bytes.Length -gt 0) {
                $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
                [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
            }
            $credential = [KingLicenseNative.Credential]::new()
            $credential.Type = $CredentialTypeGeneric
            $credential.TargetName = $target
            $credential.CredentialBlobSize = [UInt32] $bytes.Length
            $credential.CredentialBlob = $blob
            $credential.Persist = $CredentialPersistLocalMachine
            $credential.UserName = $Second
            if (-not [KingLicenseNative.NativeMethods]::CredWrite([ref] $credential, 0)) {
                $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw [ComponentModel.Win32Exception]::new($nativeError)
            }
        }
        finally {
            if ($blob -ne [IntPtr]::Zero) {
                for ($index = 0; $index -lt $bytes.Length; $index++) {
                    [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0)
                }
                [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
            }
            Clear-ByteArray $bytes
        }
    }

    "credential-delete" {
        $target = Get-TargetName $First $Second
        if (-not [KingLicenseNative.NativeMethods]::CredDelete(
            $target,
            $CredentialTypeGeneric,
            0
        )) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($nativeError -ne $ErrorNotFound) {
                throw [ComponentModel.Win32Exception]::new($nativeError)
            }
        }
    }

    "open-url" {
        $bytes = Read-EncodedInput
        try {
            $url = [Text.Encoding]::UTF8.GetString($bytes)
            $uri = $null
            if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref] $uri)) {
                throw "Activation URL is invalid."
            }
            if ($uri.Scheme -ne "https" -and -not ($uri.Scheme -eq "http" -and $uri.IsLoopback)) {
                throw "Activation URL must use HTTPS except on loopback."
            }
            $result = [KingLicenseNative.NativeMethods]::ShellExecute(
                [IntPtr]::Zero,
                "open",
                $uri.AbsoluteUri,
                $null,
                $null,
                1
            )
            if ($result.ToInt64() -le 32) {
                throw "Windows could not open the activation URL."
            }
        }
        finally {
            Clear-ByteArray $bytes
        }
    }

    "protect-path" {
        if ([string]::IsNullOrWhiteSpace($First) -or -not (Test-Path -LiteralPath $First)) {
            throw "The local path to protect does not exist."
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $sid = $identity.User
        $security = Get-Acl -LiteralPath $First
        $security.SetAccessRuleProtection($true, $false)
        foreach ($existingRule in @($security.Access)) {
            $security.RemoveAccessRuleSpecific($existingRule)
        }
        if ((Get-Item -LiteralPath $First).PSIsContainer) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.InheritanceFlags] "ContainerInherit, ObjectInherit",
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
        }
        else {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $sid,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )
        }
        $security.AddAccessRule($rule)
        Set-Acl -LiteralPath $First -AclObject $security
    }
}
