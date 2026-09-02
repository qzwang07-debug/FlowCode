# FlowCode browser extension (Stage 3)

This directory contains one Manifest V3 implementation built as separate Chrome
and Edge packages. Standard capture only runs while FlowCode Desktop owns an
active recording, and only on origins the user grants from the extension popup.

Build both unpacked packages:

```powershell
npm run build:extension
```

Load `dist/browser-extension/chrome` from `chrome://extensions` or
`dist/browser-extension/edge` from `edge://extensions`. The development public
keys keep the unpacked IDs stable and distinct; store releases may use different
IDs and must regenerate the native-host allowlists.

Prepare the Windows native host after choosing the exact Desktop executable:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-browser-bridge.ps1 `
  -DesktopExecutable "C:\Program Files\FlowCode\FlowCode.exe"
```

The script compiles the small reviewed C# stdio host into the current user's
`%LOCALAPPDATA%\FlowCode\browser-bridge` directory, writes separate exact-origin
Chrome and Edge manifests, and registers only those two per-user host keys. Use
`scripts/unregister-browser-bridge.ps1` to remove registrations owned by that
directory.

Stage 3 deliberately excludes CDP/debugger access, DOM or network snapshots,
Evidence fusion, Blueprint generation, and any OpenCode integration.

The local fixture in `e2e/site.mjs` covers form actions, same-origin and
cross-origin frames, SPA navigation, popup/new-tab behavior, upload, and
download. `e2e/prepare-extension.mjs` creates a temporary pre-authorized copy
for unattended browser QA; it refuses to write outside the OS temp directory
and never changes the production manifests. `e2e/cleanup.mjs` only removes an
OS-temp directory named `flowcode-stage3-e2e-<32 hex characters>`.
