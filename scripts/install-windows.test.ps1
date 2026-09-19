# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Skill Recorder contributors

param(
  [string]$InstallerPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "install.ps1")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$tokens = $null
$parseErrors = $null
$installerAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $InstallerPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
  $parseErrors | ForEach-Object { Write-Error $_.Message }
  throw "install.ps1 contains PowerShell syntax errors"
}

$helperNames = @(
  "ConvertTo-ExtendedLengthPath",
  "Move-DirectoryTree",
  "Remove-DirectoryTree",
  "Resolve-MachineNpmConfigPath"
)
$functionDefinitions = @(
  $installerAst.FindAll(
    {
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
    },
    $true
  )
)
$helperSource = @(
  foreach ($helperName in $helperNames) {
    $matches = @($functionDefinitions | Where-Object Name -eq $helperName)
    if ($matches.Count -ne 1) {
      throw "Expected one $helperName definition in install.ps1, found $($matches.Count)."
    }
    $matches[0].Extent.Text
  }
)
. ([scriptblock]::Create($helperSource -join [Environment]::NewLine))

$uncPath = ConvertTo-ExtendedLengthPath -Path "\\server\share\folder"
if ($uncPath -ne "\\?\UNC\server\share\folder") {
  throw "Extended-length UNC conversion returned an unexpected path: $uncPath"
}

$npmConfigRoot = Join-Path (
  [IO.Path]::GetTempPath()
) ("skill-recorder-npmrc-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $npmConfigRoot -Force | Out-Null
try {
  $machineNpmrc = Join-Path $npmConfigRoot "npmrc"
  Set-Content -LiteralPath $machineNpmrc -Value "registry=https://example.invalid/npm/" -Encoding ASCII
  $missingNpmrc = Join-Path $npmConfigRoot "missing\npmrc"

  $resolved = Resolve-MachineNpmConfigPath -CandidatePaths @($missingNpmrc, $machineNpmrc)
  if ($resolved -ne [IO.Path]::GetFullPath($machineNpmrc)) {
    throw "Resolve-MachineNpmConfigPath skipped the existing npmrc: $resolved"
  }

  # npm prints "undefined" when no global config is configured; it is not a path.
  $placeholders = Resolve-MachineNpmConfigPath -CandidatePaths @("undefined", "null", "", $null)
  if ($null -ne $placeholders) {
    throw "Resolve-MachineNpmConfigPath accepted a placeholder value: $placeholders"
  }

  # Installs on machines without any npm configuration must stay on the default registry.
  $absent = Resolve-MachineNpmConfigPath -CandidatePaths @($missingNpmrc)
  if ($null -ne $absent) {
    throw "Resolve-MachineNpmConfigPath returned a nonexistent npmrc: $absent"
  }

  $quoted = Resolve-MachineNpmConfigPath -CandidatePaths @(('"' + $machineNpmrc + '" '))
  if ($quoted -ne [IO.Path]::GetFullPath($machineNpmrc)) {
    throw "Resolve-MachineNpmConfigPath did not normalize a quoted npm path: $quoted"
  }
} finally {
  Remove-Item -LiteralPath $npmConfigRoot -Recurse -Force
}

$testRoot = Join-Path (
  [IO.Path]::GetTempPath()
) ("skill-recorder-installer-" + [guid]::NewGuid().ToString("N"))
$sourceDirectory = Join-Path $testRoot ("source-" + ("a" * 96))
$nestedDirectoryName = "b" * 120
$sourceFile = Join-Path (
  Join-Path $sourceDirectory $nestedDirectoryName
) "coverage.json"
$destinationDirectory = Join-Path $testRoot "build"
$destinationFile = Join-Path (
  Join-Path $destinationDirectory $nestedDirectoryName
) "coverage.json"

try {
  [IO.Directory]::CreateDirectory(
    (ConvertTo-ExtendedLengthPath -Path (Split-Path -Parent $sourceFile))
  ) | Out-Null
  [IO.File]::WriteAllText(
    (ConvertTo-ExtendedLengthPath -Path $sourceFile),
    "installer long-path regression"
  )
  [IO.File]::SetAttributes(
    (ConvertTo-ExtendedLengthPath -Path $sourceFile),
    [IO.FileAttributes]::ReadOnly
  )

  if ($sourceFile.Length -le 260) {
    throw "Long-path test setup produced only $($sourceFile.Length) characters."
  }

  Move-DirectoryTree -Source $sourceDirectory -Destination $destinationDirectory
  if ([IO.Directory]::Exists((ConvertTo-ExtendedLengthPath -Path $sourceDirectory))) {
    throw "Move-DirectoryTree left the source directory behind."
  }
  if (-not [IO.File]::Exists((ConvertTo-ExtendedLengthPath -Path $destinationFile))) {
    throw "Move-DirectoryTree did not move the long-path test file."
  }

  Remove-DirectoryTree -Path $destinationDirectory
  if ([IO.Directory]::Exists((ConvertTo-ExtendedLengthPath -Path $destinationDirectory))) {
    throw "Remove-DirectoryTree left the destination directory behind."
  }
  if (-not ("FlowCode.Tests.TransientFileLock" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Threading;

namespace FlowCode.Tests
{
    public sealed class TransientFileLock : IDisposable
    {
        private readonly FileStream stream;
        private readonly Thread releaseThread;
        private Exception releaseError;

        public TransientFileLock(string path, int holdMilliseconds)
        {
            stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            releaseThread = new Thread(() =>
            {
                try
                {
                    Thread.Sleep(holdMilliseconds);
                }
                catch (Exception exception)
                {
                    releaseError = exception;
                }
                finally
                {
                    stream.Dispose();
                }
            });
            releaseThread.IsBackground = true;
            releaseThread.Start();
        }

        public void WaitForRelease(int timeoutMilliseconds)
        {
            if (!releaseThread.Join(timeoutMilliseconds))
            {
                throw new TimeoutException("The transient file lock was not released in time.");
            }
            if (releaseError != null)
            {
                throw new InvalidOperationException("The transient file lock failed to release.", releaseError);
            }
        }

        public void Dispose()
        {
            releaseThread.Join();
            stream.Dispose();
        }
    }
}
"@
  }
  $lockedSourceDirectory = Join-Path $testRoot "locked-source"
  $lockedDestinationDirectory = Join-Path $testRoot "locked-destination"
  # A native thread supplies the deterministic exclusive lock. A child
  # PowerShell process keeps the directory non-movable on hosted arm64 images
  # even after disposing its stream, so it cannot model a bounded lock there.
  $lockedFile = Join-Path $lockedSourceDirectory "scanner-lock.fixture"
  [IO.Directory]::CreateDirectory($lockedSourceDirectory) | Out-Null
  [IO.File]::WriteAllText($lockedFile, "endpoint scanner simulation")

  $locker = [FlowCode.Tests.TransientFileLock]::new($lockedFile, 500)
  try {
    Move-DirectoryTree `
      -Source $lockedSourceDirectory `
      -Destination $lockedDestinationDirectory `
      -MaxAttempts 6 `
      -RetryDelayMilliseconds 100
    $locker.WaitForRelease(5000)
    if (-not [IO.Directory]::Exists($lockedDestinationDirectory)) {
      throw "Move-DirectoryTree did not recover from a transient file lock."
    }
  } finally {
    $locker.Dispose()
  }
} finally {
  Remove-DirectoryTree -Path $testRoot
}

Write-Host "Windows installer filesystem tests passed."
