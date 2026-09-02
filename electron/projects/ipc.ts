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
  ProjectFileResultSchema,
  ProjectListResultSchema,
  ProjectLocationRequestSchema,
  ProjectLocationResultSchema,
  ProjectOpenRequestSchema,
  ProjectRunCancelResultSchema,
  ProjectRunLogResultSchema,
  ProjectRunResultSchema,
  ProjectRuntimeResultSchema,
  WorktreeActionResultSchema,
  type ProjectActionResult,
  type ProjectFileResult,
  type ProjectListResult,
  type ProjectLocationResult,
  type ProjectRunCancelResult,
  type ProjectRunLogResult,
  type ProjectRunResult,
  type ProjectRuntimeResult,
  type WorktreeActionResult,
} from "../../common/ipc";
import {
  ProjectFileReadRequestSchema,
  ProjectRunControlRequestSchema,
  ProjectRunStartRequestSchema,
  ProjectRuntimeRequestSchema,
  ProjectRuntimeSnapshotSchema,
  WorktreeControlRequestSchema,
  WorktreeCreateRequestSchema,
} from "../../common/project-runtime";
import type { GitWorktreeService } from "./git";
import type { ProjectFileService } from "./project-files";
import type { ProjectManager } from "./project-manager";
import {
  availableProjectActions,
  type ProjectRunManager,
} from "./project-runner";

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

export interface ProjectIpcServices {
  projects: ProjectManager;
  files: ProjectFileService;
  runs: ProjectRunManager;
  worktrees: GitWorktreeService;
}

/** Register the project IPC surface. No handler accepts an absolute renderer path. */
export function registerProjectIpc(
  services: ProjectIpcServices,
  defaultParentDirectory: string,
): void {
  const { projects, files, runs, worktrees } = services;
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

  ipcMain.handle(
    IPC.projectRuntime,
    async (_event, rawInput: unknown): Promise<ProjectRuntimeResult> => {
      try {
        const input = ProjectRuntimeRequestSchema.parse(rawInput);
        const project = await projects.open(input.projectId);
        const [git, tree, recentRuns, projectWorktrees] = await Promise.all([
          worktrees.status(project.id),
          files.list(project.id),
          runs.list(project.id),
          worktrees.list(project.id),
        ]);
        return ProjectRuntimeResultSchema.parse({
          ok: true,
          snapshot: ProjectRuntimeSnapshotSchema.parse({
            project,
            git,
            files: tree,
            runs: recentRuns,
            worktrees: projectWorktrees,
            actions: availableProjectActions(project.kind),
          }),
        });
      } catch (error) {
        return ProjectRuntimeResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  ipcMain.handle(
    IPC.readProjectFile,
    async (_event, rawInput: unknown): Promise<ProjectFileResult> => {
      try {
        const input = ProjectFileReadRequestSchema.parse(rawInput);
        return ProjectFileResultSchema.parse({
          ok: true,
          file: await files.read(input.projectId, input.path),
        });
      } catch (error) {
        return ProjectFileResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  ipcMain.handle(
    IPC.startProjectRun,
    async (_event, rawInput: unknown): Promise<ProjectRunResult> => {
      try {
        const input = ProjectRunStartRequestSchema.parse(rawInput);
        return ProjectRunResultSchema.parse({
          ok: true,
          run: await runs.start(input.projectId, input.action),
        });
      } catch (error) {
        return ProjectRunResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  ipcMain.handle(
    IPC.cancelProjectRun,
    async (_event, rawInput: unknown): Promise<ProjectRunCancelResult> => {
      try {
        const input = ProjectRunControlRequestSchema.parse(rawInput);
        return ProjectRunCancelResultSchema.parse({
          ok: true,
          canceled: await runs.cancel(input.projectId, input.runId),
        });
      } catch (error) {
        return ProjectRunCancelResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  ipcMain.handle(
    IPC.readProjectRunLog,
    async (_event, rawInput: unknown): Promise<ProjectRunLogResult> => {
      try {
        const input = ProjectRunControlRequestSchema.parse(rawInput);
        return ProjectRunLogResultSchema.parse({
          ok: true,
          log: await runs.readLog(input.projectId, input.runId),
        });
      } catch (error) {
        return ProjectRunLogResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );

  const worktreeAction = async (
    rawInput: unknown,
    action: (projectId: string, worktreeId: string) => Promise<unknown>,
  ): Promise<WorktreeActionResult> => {
    try {
      const input = WorktreeControlRequestSchema.parse(rawInput);
      return WorktreeActionResultSchema.parse({
        ok: true,
        worktree: await action(input.projectId, input.worktreeId),
      });
    } catch (error) {
      return WorktreeActionResultSchema.parse({
        ok: false,
        error: message(error),
      });
    }
  };

  ipcMain.handle(
    IPC.createProjectWorktree,
    async (_event, rawInput: unknown): Promise<WorktreeActionResult> => {
      try {
        const input = WorktreeCreateRequestSchema.parse(rawInput);
        return WorktreeActionResultSchema.parse({
          ok: true,
          worktree: await worktrees.create(input.projectId, input.reason),
        });
      } catch (error) {
        return WorktreeActionResultSchema.parse({
          ok: false,
          error: message(error),
        });
      }
    },
  );
  ipcMain.handle(IPC.acceptProjectWorktree, (_event, rawInput: unknown) =>
    worktreeAction(rawInput, (projectId, worktreeId) =>
      worktrees.accept(projectId, worktreeId),
    ),
  );
  ipcMain.handle(IPC.rollbackProjectWorktree, (_event, rawInput: unknown) =>
    worktreeAction(rawInput, (projectId, worktreeId) =>
      worktrees.rollback(projectId, worktreeId),
    ),
  );
  ipcMain.handle(IPC.cleanupProjectWorktree, (_event, rawInput: unknown) =>
    worktreeAction(rawInput, (projectId, worktreeId) =>
      worktrees.cleanup(projectId, worktreeId),
    ),
  );
}
