$ErrorActionPreference = 'Stop'
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('flowcode-stage5a-isolation-' + [Guid]::NewGuid().ToString('N'))
$probeSource = Join-Path $PSScriptRoot 'windows-isolation.cs'
$probeCompiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
$probeAllowed = Join-Path $probeRoot 'allowed'
$probeOutside = Join-Path $probeRoot 'outside'
New-Item -ItemType Directory -Path $probeAllowed,$probeOutside -Force | Out-Null
$probeLink = Join-Path $probeAllowed 'outside-link'
New-Item -ItemType Junction -Path $probeLink -Target $probeOutside | Out-Null
try {
  & $probeCompiler /nologo /target:exe /platform:x64 /r:System.Web.Extensions.dll ('/out:' + (Join-Path $probeRoot 'probe.exe')) $probeSource
  if ($LASTEXITCODE -ne 0) { throw 'Canary compilation failed.' }
  $probeNode = if ($env:FLOWCODE_PROBE_NODE) { $env:FLOWCODE_PROBE_NODE } else { (Get-Command node -ErrorAction Stop).Source }
  & (Join-Path $probeRoot 'probe.exe') $probeRoot $probeNode (Join-Path $PSScriptRoot 'windows-node-canary.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Windows isolation probe failed; do not mark supported.' }
} finally {
  $probeResolved = [IO.Path]::GetFullPath($probeRoot)
  $probeTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($probeResolved) -ne $probeTemp -or [IO.Path]::GetFileName($probeResolved) -notmatch '^flowcode-stage5a-isolation-[a-f0-9]{32}$') { throw 'Unsafe cleanup target.' }
  # Remove the junction itself before recursive cleanup; never traverse its target.
  if (Test-Path -LiteralPath $probeLink) { [IO.Directory]::Delete($probeLink) }
  Remove-Item -LiteralPath $probeResolved -Recurse -Force
}
