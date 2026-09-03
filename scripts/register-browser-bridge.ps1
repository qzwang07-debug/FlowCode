# SPDX-License-Identifier: MIT
# Copyright (c) 2026 FlowCode contributors

[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)]
  [string]$DesktopExecutable,

  [ValidatePattern("^[a-p]{32}$")]
  [string]$ChromeExtensionId = "nmgmmghdjkhklamdbfkipjmmlhfljclk",

  [ValidatePattern("^[a-p]{32}$")]
  [string]$EdgeExtensionId = "jfahdamkedpheljhmlkpfalnlmpnagch",

  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "FlowCode\browser-bridge"),

  [string]$NativeHostSource = "",

  [switch]$SkipRegistry
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($NativeHostSource)) {
  $NativeHostSource = Join-Path (Split-Path -Parent $scriptDirectory) "electron\browser-bridge\native-host.cs"
}
$desktopPath = [IO.Path]::GetFullPath($DesktopExecutable)
$sourcePath = [IO.Path]::GetFullPath($NativeHostSource)
$installPath = [IO.Path]::GetFullPath($InstallDirectory)
if (-not [IO.File]::Exists($desktopPath)) {
  throw "FlowCode Desktop executable does not exist: $desktopPath"
}
if (-not [IO.File]::Exists($sourcePath)) {
  throw "Native host source does not exist: $sourcePath"
}
if ($ChromeExtensionId -eq $EdgeExtensionId) {
  throw "Chrome and Edge must use different extension IDs."
}

$existingHost = Join-Path $installPath "flowcode-browser-host.exe"
$existingRegistration = Join-Path $installPath "browser-bridge-registration.json"
if ([IO.File]::Exists($existingHost) -and -not [IO.File]::Exists($existingRegistration)) {
  throw "Refusing to replace an unowned executable in $installPath."
}
if ([IO.File]::Exists($existingRegistration)) {
  try {
    $owned = Get-Content -LiteralPath $existingRegistration -Raw | ConvertFrom-Json
    $names = @($owned.clients | ForEach-Object { $_.nativeHost } | Sort-Object)
    if (
      $owned.schemaVersion -ne 1 -or
      $names.Count -ne 2 -or
      $names[0] -ne "com.flowcode.browser.chrome" -or
      $names[1] -ne "com.flowcode.browser.edge"
    ) {
      throw "ownership mismatch"
    }
  } catch {
    throw "Refusing to overwrite an invalid browser bridge registration in $installPath."
  }
}

function Write-JsonAtomic {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Value
  )
  $temporary = "$Path.tmp.$([guid]::NewGuid().ToString('N'))"
  try {
    $json = $Value | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporary, "$json$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) {
      $backup = "$Path.backup.$([guid]::NewGuid().ToString('N'))"
      try {
        [IO.File]::Replace($temporary, $Path, $backup)
      } finally {
        if ([IO.File]::Exists($backup)) {
          [IO.File]::Delete($backup)
        }
      }
    } else {
      [IO.File]::Move($temporary, $Path)
    }
  } finally {
    if ([IO.File]::Exists($temporary)) {
      [IO.File]::Delete($temporary)
    }
  }
}

function Write-NativeHostManifest {
  param(
    [Parameter(Mandatory)][string]$Browser,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$ExtensionId,
    [Parameter(Mandatory)][string]$HostPath
  )
  $manifestPath = Join-Path $installPath "$Name.json"
  Write-JsonAtomic -Path $manifestPath -Value ([ordered]@{
    name = $Name
    description = "FlowCode semantic recording bridge for $Browser"
    path = $HostPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
  })
  return $manifestPath
}

if (-not $PSCmdlet.ShouldProcess($installPath, "Compile and register the FlowCode browser bridge")) {
  return
}

[IO.Directory]::CreateDirectory($installPath) | Out-Null
$hostPath = Join-Path $installPath "flowcode-browser-host.exe"
$temporaryHost = Join-Path $installPath "flowcode-browser-host.$([guid]::NewGuid().ToString('N')).exe"
try {
  Add-Type `
    -Path $sourcePath `
    -OutputAssembly $temporaryHost `
    -OutputType ConsoleApplication `
    -ReferencedAssemblies @(
      "System.dll",
      "System.Core.dll",
      "System.Runtime.Serialization.dll",
      "System.Xml.dll"
    )
  Move-Item -LiteralPath $temporaryHost -Destination $hostPath -Force
} finally {
  if ([IO.File]::Exists($temporaryHost)) {
    [IO.File]::Delete($temporaryHost)
  }
}

$registration = [ordered]@{
  schemaVersion = 1
  desktopExecutable = $desktopPath
  clients = @(
    [ordered]@{
      browser = "chrome"
      nativeHost = "com.flowcode.browser.chrome"
      origin = "chrome-extension://$ChromeExtensionId/"
    },
    [ordered]@{
      browser = "edge"
      nativeHost = "com.flowcode.browser.edge"
      origin = "chrome-extension://$EdgeExtensionId/"
    }
  )
}
Write-JsonAtomic `
  -Path (Join-Path $installPath "browser-bridge-registration.json") `
  -Value $registration

$chromeManifest = Write-NativeHostManifest `
  -Browser "Chrome" `
  -Name "com.flowcode.browser.chrome" `
  -ExtensionId $ChromeExtensionId `
  -HostPath $hostPath
$edgeManifest = Write-NativeHostManifest `
  -Browser "Edge" `
  -Name "com.flowcode.browser.edge" `
  -ExtensionId $EdgeExtensionId `
  -HostPath $hostPath

if (-not $SkipRegistry) {
  $registrations = @(
    @{
      Path = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.flowcode.browser.chrome"
      Manifest = $chromeManifest
    },
    @{
      Path = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.flowcode.browser.edge"
      Manifest = $edgeManifest
    }
  )
  foreach ($item in $registrations) {
    New-Item -Path $item.Path -Force | Out-Null
    Set-Item -Path $item.Path -Value $item.Manifest
  }
}

Write-Host "FlowCode browser bridge prepared at $installPath"
if ($SkipRegistry) {
  Write-Host "Registry changes were skipped."
}
