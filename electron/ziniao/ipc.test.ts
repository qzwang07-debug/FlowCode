import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Stage 5B environment selection stays on validated IPC and both trusted UIs", async () => {
  const [contract, preload, main, recorder, studio, picker] = await Promise.all([
    readFile("common/ipc.ts", "utf8"),
    readFile("electron/preload.cjs", "utf8"),
    readFile("electron/main.ts", "utf8"),
    readFile("src/Recorder.tsx", "utf8"),
    readFile("src/projects/ProjectStudio.tsx", "utf8"),
    readFile("src/ziniao/ZiniaoEnvironmentPicker.tsx", "utf8"),
  ]);
  for (const channel of [
    "ziniao:environment",
    "ziniao:store-search",
    "ziniao:prepare",
    "ziniao:prepare-cancel",
    "ziniao:page-select",
    "ziniao:status-changed",
  ]) {
    assert.match(contract, new RegExp(channel.replaceAll("-", "\\-")));
    assert.match(preload, new RegExp(channel.replaceAll("-", "\\-")));
  }
  assert.match(main, /registerZiniaoIpc\(ziniaoEnvironment\)/);
  assert.match(main, /BrowserCaptureCoordinator/);
  assert.match(recorder, /ZiniaoEnvironmentPicker/);
  assert.match(studio, /BrowserEnvironmentPanel/);
  assert.match(picker, /type="search"/);
  assert.match(picker, /allowAssociatedPopups/);
  assert.doesNotMatch(picker, /cdpUrl|webSocketDebuggerUrl|apiKey/i);
});
