<#
.SYNOPSIS
    YukiOshi Code Windows Installer

.DESCRIPTION
    Downloads and installs the YukiOshi Code CLI binary for Windows,
    verifying release checksums, extracting yukioshi.exe into
    $env:USERPROFILE\.yukioshi\bin, and adding it to the user PATH.

.PARAMETER Version
    Specific version to install (e.g., "0.3.0"). Defaults to latest.

.PARAMETER NoModifyPath
    Do not modify the user PATH environment variable.

.PARAMETER DryRun
    Print the download URL, SHA256SUMS URL, and target folder without downloading or modifying the system.
#>

[CmdletBinding()]
param(
    [Alias("v")]
    [string]$Version,

    [Alias("no-modify-path")]
    [switch]$NoModifyPath,

    [Alias("dry-run")]
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Detect OS
$isWindowsOS = if ($null -ne $IsWindows) {
    $IsWindows
} else {
    [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

# Detect Architecture (x64 or arm64)
$rawArch = $env:PROCESSOR_ARCHITEW6432
if (-not $rawArch) {
    $rawArch = $env:PROCESSOR_ARCHITECTURE
}
if (-not $rawArch) {
    try {
        $rawArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch {}
}
if (-not $rawArch -and (Get-Command uname -ErrorAction SilentlyContinue)) {
    try {
        $rawArch = (& uname -m).Trim()
    } catch {}
}

$arch = switch -Regex ($rawArch) {
    '^(AMD64|x86_64|x64)$' { 'x64' }
    '^(ARM64|aarch64)$'   { 'arm64' }
    default                { $null }
}

if (-not $arch) {
    Write-Error "Unsupported architecture: '$rawArch'. YukiOshi Code supports x64 and arm64 on Windows."
    exit 1
}

# Detect AVX2 support on x64
$needsBaseline = $false
if ($arch -eq 'x64') {
    $hasAvx2 = $false

    # 1. Check .NET Core / PowerShell 7+ hardware intrinsics
    $avx2Type = "System.Runtime.Intrinsics.X86.Avx2" -as [type]
    if ($avx2Type) {
        try {
            $hasAvx2 = [System.Runtime.Intrinsics.X86.Avx2]::IsSupported
        } catch {}
    }

    # 2. Check Linux /proc/cpuinfo (for containerized testing)
    if (-not $hasAvx2 -and (Test-Path "/proc/cpuinfo")) {
        try {
            $hasAvx2 = [bool](Select-String -Path "/proc/cpuinfo" -Pattern "\bavx2\b" -Quiet)
        } catch {}
    }

    # 3. Check Windows kernel32 IsProcessorFeaturePresent(40) (PowerShell 5.1+ on Windows)
    if (-not $hasAvx2 -and $isWindowsOS) {
        try {
            $k32 = "Win32.Kernel32Avx2" -as [type]
            if (-not $k32) {
                $k32 = Add-Type -MemberDefinition @"
[DllImport("kernel32.dll")]
public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);
"@ -Name "Kernel32Avx2" -Namespace "Win32" -PassThru -ErrorAction Stop
            }
            # 40 = PF_AVX2_INSTRUCTIONS_AVAILABLE
            $hasAvx2 = [bool]$k32::IsProcessorFeaturePresent(40)
        } catch {}
    }

    if (-not $hasAvx2) {
        $needsBaseline = $true
    }
}

# Determine asset name matching release build names
$target = "windows-$arch"
if ($needsBaseline) {
    $target = "$target-baseline"
}
$assetName = "yukioshi-$target.zip"

$repo = if ($env:YUKIOSHI_GITHUB_REPO) { $env:YUKIOSHI_GITHUB_REPO } else { "ahmed-alxawad/YukiOshiCode" }

if ($Version) {
    $cleanVersion = $Version.Trim()
    if ($cleanVersion.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) {
        $cleanVersion = $cleanVersion.Substring(1)
    }
    $url = "https://github.com/$repo/releases/download/v$cleanVersion/$assetName"
    $checksumUrl = "https://github.com/$repo/releases/download/v$cleanVersion/SHA256SUMS"
} else {
    $url = "https://github.com/$repo/releases/latest/download/$assetName"
    $checksumUrl = "https://github.com/$repo/releases/latest/download/SHA256SUMS"
}

$profileDir = if ($env:USERPROFILE) {
    $env:USERPROFILE
} elseif ($HOME) {
    $HOME
} else {
    [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
}

$targetFolder = Join-Path $profileDir ".yukioshi\bin"

if ($DryRun) {
    Write-Output "URL: $url"
    Write-Output "SHA256SUMS: $checksumUrl"
    Write-Output "Target folder: $targetFolder"
    return
}

# Ensure TLS 1.2 is enabled for PowerShell 5.1
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch {}

if (-not (Test-Path -Path $targetFolder)) {
    New-Item -ItemType Directory -Path $targetFolder -Force | Out-Null
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("yukioshi-install-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$zipPath = Join-Path $tempDir $assetName
$checksumPath = Join-Path $tempDir "SHA256SUMS"

try {
    Write-Host "Downloading YukiOshi Code from $url..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    # Download SHA256SUMS if available
    $hasChecksum = $false
    try {
        Write-Host "Downloading checksums from $checksumUrl..."
        Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing -ErrorAction Stop
        $hasChecksum = $true
    } catch {
        Write-Warning "SHA256SUMS not found for this release ($checksumUrl). Skipping checksum verification."
    }

    if ($hasChecksum -and (Test-Path -Path $checksumPath)) {
        Write-Host "Verifying checksum for $assetName..."
        $fileHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = $null

        foreach ($line in (Get-Content -Path $checksumPath)) {
            $trimmed = $line.Trim()
            if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) { continue }
            if ($trimmed -match '^([a-fA-F0-9]{64})\s+[*]?(.+)$') {
                $h = $Matches[1].ToLowerInvariant()
                $f = $Matches[2].Trim()
                if ($f -eq $assetName) {
                    $expectedHash = $h
                    break
                }
            }
        }

        if (-not $expectedHash) {
            throw "Asset '$assetName' not found in SHA256SUMS."
        }

        if ($fileHash -ne $expectedHash) {
            throw "Checksum verification failed for $assetName! Expected: $expectedHash, got: $fileHash"
        }

        Write-Host "Checksum verified: $fileHash"
    }

    Write-Host "Extracting $assetName..."
    $extractedDir = Join-Path $tempDir "extracted"
    New-Item -ItemType Directory -Path $extractedDir -Force | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $extractedDir -Force

    $exeSource = Get-ChildItem -Path $extractedDir -Filter "yukioshi.exe" -Recurse | Select-Object -First 1
    if (-not $exeSource) {
        $exeSource = Get-ChildItem -Path $extractedDir -Filter "yukioshi" -Recurse | Select-Object -First 1
    }

    if (-not $exeSource) {
        throw "Could not find yukioshi.exe in the downloaded archive."
    }

    # Before replacing an existing binary, test the new binary with --version
    if ($isWindowsOS) {
        Write-Host "Verifying new binary..."
        $versionOutput = & $exeSource.FullName --version
        if ($LASTEXITCODE -ne 0) {
            throw "New binary failed verification with --version (exit code $LASTEXITCODE)."
        }
        Write-Host "Verified new binary version: $versionOutput"
    }

    $destPath = Join-Path $targetFolder "yukioshi.exe"
    $oldBackupPath = Join-Path $targetFolder "yukioshi.exe.old"

    if (Test-Path -Path $destPath) {
        Write-Host "Backing up existing binary to yukioshi.exe.old..."
        Move-Item -Path $destPath -Destination $oldBackupPath -Force
    }

    Copy-Item -Path $exeSource.FullName -Destination $destPath -Force
} finally {
    Remove-Item -Recurse -Force -Path $tempDir -ErrorAction SilentlyContinue
}

# Update PATH if requested
if (-not $NoModifyPath) {
    if ($isWindowsOS) {
        try {
            $userPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
            $pathParts = ($userPath -split ';') | Where-Object { $_ -ne "" }
            if ($pathParts -notcontains $targetFolder) {
                $newUserPath = if ([string]::IsNullOrEmpty($userPath)) { $targetFolder } else { "$userPath;$targetFolder" }
                [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, [System.EnvironmentVariableTarget]::User)
                Write-Host "Added $targetFolder to User PATH."
            } else {
                Write-Host "$targetFolder is already in User PATH."
            }
        } catch {
            Write-Warning "Could not update User PATH environment variable: $_"
        }
    }
    $currentPaths = ($env:Path -split ';') | Where-Object { $_ -ne "" }
    if ($currentPaths -notcontains $targetFolder) {
        $env:Path = "$targetFolder;$env:Path"
    }
}

Write-Host ""
Write-Host "YukiOshi Code" -ForegroundColor Yellow
Write-Host ""
Write-Host "Installed to $destPath"
Write-Host ""
Write-Host "To start:"
Write-Host ""
Write-Host "cd <project>  # Open directory"
Write-Host "yukioshi      # Run command"
Write-Host ""
Write-Host "For more information visit https://github.com/$repo#readme"
Write-Host ""
