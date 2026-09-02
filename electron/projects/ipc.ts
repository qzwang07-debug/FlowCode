import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from "electron";

import {
  IPC,
  ProjectActionResultSchema,
  ProjectCreateRequestSchema,
  ProjectListResultSchema,
  ProjectLocationRequestSchema,
  ProjectLocationResultSchema,
  ProjectOpenRequestSchema,
  type ProjectActionResult,
  type ProjectListResult,
  type ProjectLocationResult,
} from "../../common/ipc";
import type { ProjectManager } from "./project-manager";

const LOCATION_TTL_MS = 10 * 60 * 1_000;

interface LocationCapability {
  name: string;
  targetPath: string;
  expiresAt: number;
  webContentsId: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register the Stage 1 project IPC surface. No handler accepts a renderer path. */
export function registerProjectIpc(
  projects: ProjectManager,
  defaultParentDirectory: string,
): void {
  const locations = new Map<string, LocationCapability>();

  const pruneLocations = () => {
    const now = Date.now();
    for (const [token, capability] of locations) {
      if (capability.expiresAt <= now) locations.delete(token);
    }
  };

  ipcMain.handle(IPC.listProjects, async (): Promise<ProjectListResult> => {
    try {
      return ProjectListResultSchema.parse({
        ok: true,
        projects: await projects.list(),
      });
    } catch (error) {
      return ProjectListResultSchema.parse({
        ok: false,
        error: message(error),
      });
    }
  });

  ipcMain.handle(
    IPC.selectProjectLocation,
    async (event, rawInput: unknown): Promise<ProjectLocationResult> => {
      try {
        const input = ProjectLocationRequestSchema.parse(rawInput);
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options: OpenDialogOptions = {
          title: "Choose a parent folder for the FlowCode project",
          defaultPath: defaultParentDirectory,
          buttonLabel: "Use this folder",
          properties: ["openDirectory", "createDirectory"],
        };
        const result = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length !== 1) {
          return ProjectLocationResultSchema.parse({
            ok: true,
            canceled: true,
          });
        }

        const targetPath = await projects.planTarget(
          result.filePaths[0],
          input.name,
        );
        pruneLocations();
        const token = randomUUID();
        locations.set(token, {
          name: input.name,
          targetPath,
          expiresAt: Date.now() + LOCATION_TTL_MS,
          webContentsId: event.sender.id,
        });
        return ProjectLocationResultSchema.parse({
          ok: true,
          selection: { token, targetPath },
        });
      } catch (error) {
        return ProjectLocationResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  ipcMain.handle(
    IPC.createProject,
    async (event, rawInput: unknown): Promise<ProjectActionResult> => {
      try {
        const input = ProjectCreateRequestSchema.parse(rawInput);
        pruneLocations();
        const capability = locations.get(input.locationToken);
        locations.delete(input.locationToken);
        if (!capability || capability.expiresAt <= Date.now()) {
          throw new Error(
            "The selected project location expired. Choose it again.",
          );
        }
        if (capability.webContentsId !== event.sender.id) {
          throw new Error(
            "The selected project location belongs to another window.",
          );
        }
        if (capability.name !== input.name) {
          throw new Error(
            "The project name changed. Choose the location again.",
          );
        }
        const project = await projects.create({
          name: input.name,
          kind: input.kind,
          targetPath: capability.targetPath,
        });
        return ProjectActionResultSchema.parse({ ok: true, project });
      } catch (error) {
        return ProjectActionResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  ipcMain.handle(
    IPC.openProject,
    async (_event, rawInput: unknown): Promise<ProjectActionResult> => {
      try {
        const input = ProjectOpenRequestSchema.parse(rawInput);
        return ProjectActionResultSchema.parse({
          ok: true,
          project: await projects.open(input.projectId),
        });
      } catch (error) {
        return ProjectActionResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );
}
