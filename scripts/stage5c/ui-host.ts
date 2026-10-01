import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { BrowserSemanticEventSchema } from "../../common/browser";
import { processEvidenceSession } from "../../electron/evidence/processor";
import { ProviderStore } from "../../electron/analyzer/provider-store";
import { WindowsCredentialVault } from "../../electron/analyzer/windows-credentials";
const root = path.resolve(".stage5c/ui-qa");
if (process.argv.includes("--approved-profile")) {
  const store = new ProviderStore(path.join(root, "analyzer"), new WindowsCredentialVault());
  await store.save({ settings: JSON.parse(await readFile("fixtures/stage5c/reviewed-provider.json", "utf8")) });
  if (!(await store.view()).keyPresent) throw new Error("The already-authorized local key is absent; no UI connection state fabricated.");
  await store.setCapabilities(JSON.parse(await readFile("fixtures/stage5c/provider-capabilities.json", "utf8")));
}
const sessionRoot = path.join(root, "sessions-assertions");
await mkdir(sessionRoot, { recursive: true });
for (const provider of ["chrome", "edge", "ziniao"]) {
  const id = `qa-${provider}`; const directory = path.join(sessionRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "session.json"), JSON.stringify({ schemaVersion: 2, eventSchemaVersion: 1,
    startedAtMonotonicMs: 1000, id, startedAt: 1000, stoppedAt: 9000, platform: "win32", appVersion: "ui-fixture",
    link: { mode: "analyze-only", browserEnhancement: "semantic" } }));
  const sourceId = provider === "ziniao" ? "ziniao:qa-source" : `${provider}-qa-source`;
  const common = { tabId: 1, frameId: 0, documentId: "fixture-document", url: "https://fixture.test/search" };
  const events = [
    { type: "browser.navigate", payload: { ...common, navigationKind: "document" } },
    ...["Draft", "Final"].map(value => ({ type: "browser.fill", payload: { ...common,
      target: { tag: "input", role: "textbox", name: "Search", inputType: "text" },
      locators: [{ kind: "role", value: "textbox|Search", unique: true, score: 100 }],
      value: { kind: "text", value, length: value.length, truncated: false } } })),
    { type: "browser.click", payload: { ...common, target: { tag: "button", role: "button", name: "Search products" },
      locators: [{ kind: "role", value: "button|Search products", unique: true, score: 100 }], button: 0, modifiers: [] } },
  ].map((event, seq) => BrowserSemanticEventSchema.parse({ ...event, schemaVersion: 1, eventId: `qa-event-${seq}`, sessionId: id,
    sourceId, source: "browser", seq, epochMs: 2000 + seq * 1000, monotonicMs: 1000 + seq * 1000 }));
  await writeFile(path.join(directory, "browser-events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(path.join(directory, "events.jsonl"), JSON.stringify({ schemaVersion: 1, eventId: "qa-marker", sessionId: id,
    sourceId: "user", source: "user", seq: 0, epochMs: 5500, monotonicMs: 4500, type: "assertion.marker",
    payload: { markerId: "qa-marker", note: "Search results are visible" } }) + "\n");
  await processEvidenceSession(directory, "web-test");
}
const socket = createServer(); await new Promise<void>(r => socket.listen(0, "127.0.0.1", r));
const port = (socket.address() as { port: number }).port; await new Promise<void>(r => socket.close(() => r()));
const env: NodeJS.ProcessEnv = { ...process.env, SKILL_RECORDER_SESSIONS_DIR: sessionRoot,
  FLOWCODE_ANALYZER_TEST_ROOT: path.join(root, "analyzer"), FLOWCODE_BROWSER_BRIDGE_DIR: path.join(root, "bridge") };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.resolve("node_modules/electron/dist/electron.exe"), [path.resolve("."), `--remote-debugging-port=${port}`, "--no-sandbox"],
  { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
console.log(JSON.stringify({ pid: child.pid, port, syntheticSessions: 3, root }));
await writeFile(path.join(root, "host.json"), JSON.stringify({ pid: child.pid, port }));
process.on("SIGINT", () => { child.kill(); });
await new Promise<void>(r => child.once("close", () => r()));
