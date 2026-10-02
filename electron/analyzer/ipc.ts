import { BrowserWindow, dialog, ipcMain } from "electron";
import { AnalyzerPreviewRequestSchema, AnalyzerStartSchema, AnalyzerControlSchema, BlueprintEditRequestSchema, ProviderSaveSchema, BlueprintCompareSchema } from "../../common/analyzer";
import { EvidenceSessionRequestSchema } from "../../common/evidence";
import { IPC } from "../../common/ipc";
import type { AnalyzerService } from "./service";
import type { RuntimeSettings } from "./runtime-settings";
import { migrationState } from "./migration-gate";

export function registerAnalyzerIpc(service: AnalyzerService, runtime: RuntimeSettings) {
  const handle = (channel: string, action: (raw: unknown) => Promise<unknown>) => ipcMain.handle(channel, async (event, raw: unknown) => {
    try {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Invalid sender.");
      return { ok: true, value: await action(raw) };
    } catch {
      // Never return Zod input dumps, native paths, provider responses or secrets.
      return { ok: false, error: "Request could not complete. Check the model connection/runtime, current review version and authorization; retry after reloading. Validation failures never enable a raw-data fallback." };
    }
  });
  handle(IPC.analyzerSettings, async () => { const view = await service.providerView(); return { ...view, runtime: await runtime.view(), ...migrationState(view) }; });
  handle(IPC.analyzerSaveSettings, async raw => service.saveProvider(ProviderSaveSchema.parse(raw)));
  handle(IPC.analyzerTestProvider, async () => service.testProvider());
  handle(IPC.analyzerSnapshot, async raw => service.snapshot(EvidenceSessionRequestSchema.parse(raw).sessionId));
  handle(IPC.analyzerEdit, async raw => service.edit(BlueprintEditRequestSchema.parse(raw)));
  handle(IPC.analyzerCompare, async raw => service.compare(BlueprintCompareSchema.parse(raw)));
  handle(IPC.analyzerPreview, async raw => service.preview(AnalyzerPreviewRequestSchema.parse(raw)));
  handle(IPC.analyzerStart, async raw => service.start(AnalyzerStartSchema.parse(raw)));
  handle(IPC.analyzerCancel, async raw => service.cancel(AnalyzerControlSchema.parse(raw).runId));
  handle(IPC.analyzerRevoke, async raw => { await service.revoke(EvidenceSessionRequestSchema.parse(raw).sessionId); return { revoked: true }; });
  ipcMain.handle(IPC.analyzerSelectRuntime, async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: "Invalid window." };
    try {
      const choice = await dialog.showOpenDialog(owner, { title: "Select reviewed OpenCode 1.18.29", properties: ["openFile"], filters: [{ name: "OpenCode executable", extensions: ["exe"] }] });
      return { ok: true, value: choice.canceled ? { canceled: true } : await runtime.select(choice.filePaths[0]!) };
    } catch { return { ok: false, error: "Selected executable did not match the reviewed version/hash." }; }
  });
}
