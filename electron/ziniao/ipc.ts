import { ipcMain } from "electron";

import { IPC } from "../../common/ipc";
import {
  ZiniaoActionResultSchema,
  ZiniaoEnvironmentSnapshotSchema,
  ZiniaoPageSelectionResultSchema,
  ZiniaoPrepareResultSchema,
  ZiniaoStoreSearchResultSchema,
} from "../../common/ziniao-recording";
import type { ZiniaoEnvironmentService } from "./environment-service";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Ziniao request failed.";
}

export function registerZiniaoIpc(service: ZiniaoEnvironmentService): void {
  let preparation: AbortController | null = null;
  ipcMain.handle(IPC.ziniaoEnvironment, async () =>
    ZiniaoEnvironmentSnapshotSchema.parse(await service.snapshot()),
  );
  ipcMain.handle(IPC.ziniaoStoreSearch, async (_event, raw: unknown) => {
    try {
      return ZiniaoStoreSearchResultSchema.parse(await service.search(raw));
    } catch (error) {
      return ZiniaoStoreSearchResultSchema.parse({
        ok: false,
        error: message(error),
      });
    }
  });
  ipcMain.handle(IPC.ziniaoPrepare, async (_event, raw: unknown) => {
    preparation?.abort();
    const controller = new AbortController();
    preparation = controller;
    try {
      return ZiniaoPrepareResultSchema.parse(
        await service.prepare(raw, controller.signal),
      );
    } catch (error) {
      return ZiniaoPrepareResultSchema.parse({
        ok: false,
        error: message(error),
      });
    } finally {
      if (preparation === controller) preparation = null;
    }
  });
  ipcMain.handle(IPC.ziniaoCancelPrepare, () => {
    preparation?.abort();
    preparation = null;
    return ZiniaoActionResultSchema.parse({ ok: true });
  });
  ipcMain.handle(IPC.ziniaoSelectPage, async (_event, raw: unknown) => {
    try {
      return ZiniaoPageSelectionResultSchema.parse(
        await service.selectPage(raw),
      );
    } catch (error) {
      return ZiniaoPageSelectionResultSchema.parse({
        ok: false,
        error: message(error),
      });
    }
  });
}
