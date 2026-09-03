import { BrowserWindow, dialog, ipcMain } from "electron";

import {
  EvidenceExportRequestSchema,
  EvidenceReviewUpdateRequestSchema,
  EvidenceSessionRequestSchema,
} from "../../common/evidence";
import { IPC } from "../../common/ipc";
import type { EvidenceService } from "./service";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerEvidenceIpc(service: EvidenceService): void {
  ipcMain.handle(IPC.listEvidenceRecordings, async () => {
    try {
      return { ok: true as const, recordings: await service.list() };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.getEvidenceReview, async (_event, rawInput: unknown) => {
    try {
      const input = EvidenceSessionRequestSchema.parse(rawInput);
      return { ok: true as const, snapshot: await service.get(input.sessionId) };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.updateEvidenceReview, async (_event, rawInput: unknown) => {
    try {
      const input = EvidenceReviewUpdateRequestSchema.parse(rawInput);
      return { ok: true as const, snapshot: await service.update(input) };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.exportBlueprint, async (event, rawInput: unknown) => {
    try {
      const input = EvidenceExportRequestSchema.parse(rawInput);
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: "Export Automation Blueprint",
        defaultPath: `FlowCode-Blueprint-${input.sessionId}.zip`,
        buttonLabel: "Export Blueprint",
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      };
      const selected = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      if (selected.canceled || !selected.filePath) {
        return { ok: true as const, canceled: true as const };
      }
      await service.export(
        input.sessionId,
        selected.filePath,
        input.includeScreenshots,
      );
      return { ok: true as const, path: selected.filePath };
    } catch (error) {
      return { ok: false as const, error: errorMessage(error) };
    }
  });
}
