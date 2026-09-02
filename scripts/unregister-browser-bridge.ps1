# SPDX-License-Identifier: MIT
# Copyright (c) 2026 FlowCode contributors

[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "FlowCode\browser-bridge")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installPath = [IO.Path]::GetFullPath($InstallDirectory)
$registrations = @(
  @{
    Path = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.flowcode.browser.chrome"
    Manifest = (Join-Path $installPath "com.flowcode.browser.chrome.json")
  },
  @{
    Path = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.flowcode.browser.edge"
    Manifest = (Join-Path $installPath "com.flowcode.browser.edge.json")
  }
)

foreach ($item in $registrations) {
  if (-not (Test-Path -LiteralPath $item.Path)) {
    continue
  }
  $current = (Get-Item -LiteralPath $item.Path).GetValue("")
  if ($current -eq $item.Manifest -and $PSCmdlet.ShouldProcess($item.Path, "Remove FlowCode native-host registration")) {
    Remove-Item -LiteralPath $item.Path -Force
  }
}

if ([IO.Directory]::Exists($installPath)) {
  $ownedFiles = @(
    "browser-bridge-registration.json",
    "browser-bridge-runtime.json",
    "com.flowcode.browser.chrome.json",
    "com.flowcode.browser.edge.json",
    "flowcode-browser-host.exe"
  )
  foreach ($name in $ownedFiles) {
    $file = Join-Path $installPath $name
    if ([IO.File]::Exists($file) -and $PSCmdlet.ShouldProcess($file, "Remove FlowCode browser bridge file")) {
      Remove-Item -LiteralPath $file -Force
    }
  }
  $remaining = @(Get-ChildItem -LiteralPath $installPath -Force)
  if ($remaining.Count -eq 0 -and $PSCmdlet.ShouldProcess($installPath, "Remove empty FlowCode browser bridge directory")) {
    Remove-Item -LiteralPath $installPath -Force
  } elseif ($remaining.Count -gt 0) {
    Write-Warning "Keeping $installPath because it contains files FlowCode does not own."
  }
}
