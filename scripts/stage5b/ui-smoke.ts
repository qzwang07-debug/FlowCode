import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { _electron: electron } = await import(
  pathToFileURL(
    path.resolve(".stage5a", "tools", "node_modules", "playwright", "index.mjs"),
  ).href
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: path.resolve("node_modules", "electron", "dist", "electron.exe"),
  args: [path.resolve("."), "--no-sandbox"],
  env,
});
const evidence = path.resolve(".stage5b", "evidence");
await mkdir(evidence, { recursive: true });
try {
  let recorder: any;
  const deadline = Date.now() + 15000;
  while (!recorder && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if ((await candidate.title()) === "FlowCode") {
        recorder = candidate;
        break;
      }
    }
    if (!recorder) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!recorder) throw new Error("FlowCode recorder window did not open.");
  const uiErrors: string[] = [];
  const watchErrors = (page: any) => {
    page.on("pageerror", (error: Error) => uiErrors.push(error.message));
    page.on("console", (message: any) => {
      if (message.type() === "error") uiErrors.push(message.text());
    });
  };
  watchErrors(recorder);
  await recorder.waitForLoadState("domcontentloaded");
  await recorder.getByTitle("Recording settings").click();
  const settings = recorder.locator(".narrate-settings");
  await settings.waitFor({ state: "visible" });
  const settingsText = await settings.innerText();
  assert.match(settingsText, /Browser environment/);
  assert.match(settingsText, /Google Chrome/);
  assert.match(settingsText, /After recording/);
  assert.equal(await recorder.getByLabel("Provider").count(), 1);
  await recorder.screenshot({
    path: path.join(evidence, "recorder-environment-picker.png"),
  });
  await recorder.keyboard.press("Escape");
  await recorder.getByRole("button", { name: "Open Project Studio" }).click();
  let studio: any;
  const studioDeadline = Date.now() + 15000;
  while (!studio && Date.now() < studioDeadline) {
    for (const candidate of app.windows()) {
      if (
        (await candidate.title()) === "FlowCode: Project Studio" ||
        candidate.url().endsWith("#projects")
      ) {
        studio = candidate;
        break;
      }
    }
    if (!studio) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!studio) throw new Error("Project Studio window did not open.");
  watchErrors(studio);
  await studio.waitForLoadState("domcontentloaded");
  await studio
    .getByRole("button", { name: "Browser environments" })
    .click();
  await studio.getByRole("heading", { name: "Browser environments" }).waitFor();
  assert.equal(await studio.getByLabel("Provider").count(), 1);
  assert.match(await studio.locator("main").innerText(), /exact store and page/i);
  await studio.screenshot({
    path: path.join(evidence, "project-studio-environments.png"),
  });
  assert.deepEqual(uiErrors, []);
  console.log(
    JSON.stringify(
      {
        recorderSettingsVisible: true,
        projectStudioEnvironmentVisible: true,
        labeledProviderControls: 2,
        screenshots: 2,
        consoleErrors: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
