import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

import { windowIcon } from "../icons";

const dirname = path.dirname(fileURLToPath(import.meta.url));

function loadProjectRoute(window: BrowserWindow): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void window.loadURL(`${devUrl}#projects`);
  } else {
    void window.loadFile(path.join(dirname, "..", "dist", "index.html"), {
      hash: "projects",
    });
  }
}

export function createProjectStudioWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    show: false,
    title: "FlowCode: Project Studio",
    icon: windowIcon(),
    backgroundColor: "#f5f4f1",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  loadProjectRoute(window);
  return window;
}
