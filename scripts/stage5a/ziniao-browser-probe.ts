import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { z } from "zod";
import { BrowserContentEventSchema } from "../../common/browser";
import { selectedZiniaoEndpoint } from "./ziniao-endpoint";

const out = path.resolve(".stage5a/evidence");
await mkdir(out, { recursive: true });
await build({
  configFile: false,
  publicDir: false,
  logLevel: "error",
  build: {
    outDir: path.resolve(".stage5a/sensor"),
    emptyOutDir: false,
    lib: {
      entry: path.resolve("scripts/stage5a/semantic-sensor.ts"),
      name: "FlowCodeProbe",
      formats: ["iife"],
      fileName: () => "sensor.js",
    },
    minify: false,
  },
});
const sensor = await readFile(
  path.resolve(".stage5a/sensor/sensor.js"),
  "utf8",
);
const connection = await selectedZiniaoEndpoint();
const { chromium } = await import(
  pathToFileURL(
    path.resolve(".stage5a/tools/node_modules/playwright/index.mjs"),
  ).href
);
const browser = await chromium.connectOverCDP(connection.endpoint, {
  noDefaults: true,
  isLocal: true,
});
const context = browser.contexts()[0];
if (!context) throw new Error("Selected store has no existing context.");
const originalPages = context.pages();
const originalPageCount = originalPages.length;
const nonce = randomBytes(12).toString("hex");
const downloadName = `flowcode-fixture-${nonce}.csv`;
const prefix = `/flowcode-5a-${nonce}`;
const existingHttpPage = originalPages.find((p: any) =>
  /^https:\/\//.test(p.url()),
);
if (!existingHttpPage)
  throw new Error(
    "An already authorized HTTPS page is required for this client-restricted fixture.",
  );
const fixtureOrigin = new URL(existingHttpPage.url()).origin;
const crossUrl = new URL(fixtureOrigin);
crossUrl.port = "8443";
const crossOrigin = crossUrl.origin;
const route = (name: string) => `${prefix}/${name}`;
let port = 0;
const server = createServer((req, res) => {
  if (!req.url?.startsWith(prefix)) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.url === route("download")) {
    res.writeHead(200, {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${downloadName}"`,
    });
    res.end("id,status\nfixture,success\n");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === route("frame")) {
    res.end(
      '<!doctype html><html><body><label>Frame input<input aria-label="Frame input"></label></body></html>',
    );
    return;
  }
  if (req.url === route("popup")) {
    res.end(
      "<!doctype html><html><body><h1>FlowCode fixture popup</h1><button>Popup action</button></body></html>",
    );
    return;
  }
  if (req.url === route("next")) {
    res.end(
      "<!doctype html><html><body><h1>FlowCode navigation fixture</h1><button>After navigation</button></body></html>",
    );
    return;
  }
  res.end(`<!doctype html><html><head><title>FlowCode 5A 本地接入验证</title></head><body>
  <h1>FlowCode 5A 本地测试</h1><p>仅操作本地测试数据。原有店铺页面保持不变。</p>
  <form id="fixture-form"><label>Customer<input aria-label="Customer"></label><label>Password<input type="password" aria-label="Password"></label>
  <select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select>
  <label><input type="checkbox" aria-label="Accepted">Accepted</label><button type="submit">Submit fixture</button></form><p role="status"></p>
  <button id="popup">Open fixture popup</button><button id="spa">SPA navigation</button><a href="${route("next")}">Navigate fixture</a>
  <label>Fixture upload<input type="file" aria-label="Fixture upload"></label><a href="${route("download")}">Download fixture</a>
  <iframe title="Same-origin fixture" src="${route("frame")}"></iframe><iframe title="Cross-origin fixture" src="${crossOrigin}${route("frame")}"></iframe>
  <div id="shadow"></div><section><h2>人工输入验证</h2><p>请在此输入任意测试文字，再点击“完成人工验证”。</p><input aria-label="人工验证输入"><button id="human">完成人工验证</button></section>
  <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('[role=status]').textContent='Fixture success'};
  document.querySelector('#popup').onclick=()=>window.open('${route("popup")}');document.querySelector('#spa').onclick=()=>history.pushState({},'',location.pathname+'#spa');
  document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';</script></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
port = (server.address() as { port: number }).port;
const allowedOrigins = new Set([fixtureOrigin, crossOrigin]);
// Ziniao blocks direct loopback navigation. Fulfill ONLY these unique synthetic
// test routes locally; no store site is intercepted and no proxy setting changes.
const fixturePattern = (url: URL) =>
  allowedOrigins.has(url.origin) && url.pathname.startsWith(prefix + "/");
const fulfillFixture = async (request: any) => {
  const url = new URL(request.request().url());
  const response = await fetch(`http://127.0.0.1:${port}${url.pathname}`);
  await request.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  });
};
await context.route(fixturePattern, fulfillFixture);
const bindingName = `flowcodeProbe_${nonce}`,
  worldName = `flowcode-probe-${nonce}`,
  token = randomBytes(24).toString("hex");
const events: Array<{
  sequence: number;
  actor: string;
  type: string;
  payload: unknown;
  frame: string;
}> = [];
const attached: Array<{
  cdp: any;
  contexts: Map<number, string>;
  frames: Map<string, string>;
  participating: Set<number>;
  flushed: Set<number>;
}> = [];
const ownedPages = new Set<any>();
let actor = "automation",
  gaps = 0,
  rejectedBindings = 0;
const Packet = z
  .object({
    token: z.literal(token),
    seq: z.number().int().nonnegative(),
    epochMs: z.number().finite(),
    monotonicMs: z.number().finite(),
    type: z.string(),
    payload: z.unknown(),
  })
  .strict();
async function attach(page: any) {
  ownedPages.add(page);
  const cdp = await context.newCDPSession(page);
  const entry = {
    cdp,
    contexts: new Map<number, string>(),
    frames: new Map<string, string>(),
    participating: new Set<number>(),
    flushed: new Set<number>(),
  };
  attached.push(entry);
  cdp.on("Runtime.executionContextCreated", ({ context: c }: any) => {
    if (
      c.name === worldName &&
      c.auxData?.isDefault === false &&
      c.auxData?.frameId
    )
      entry.contexts.set(c.id, c.auxData.frameId);
  });
  cdp.on("Page.frameNavigated", ({ frame }: any) =>
    entry.frames.set(frame.id, frame.url),
  );
  cdp.on("Page.frameDetached", ({ frameId }: any) =>
    entry.frames.delete(frameId),
  );
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }: any) =>
    entry.contexts.delete(executionContextId),
  );
  cdp.on("Runtime.executionContextsCleared", () => entry.contexts.clear());
  cdp.on("Runtime.bindingCalled", (message: any) => {
    if (
      message.name !== bindingName ||
      !entry.contexts.has(message.executionContextId)
    ) {
      rejectedBindings++;
      return;
    }
    try {
      const frameUrl = new URL(
        entry.frames.get(entry.contexts.get(message.executionContextId)!) ??
          "about:blank",
      );
      if (
        !allowedOrigins.has(frameUrl.origin) ||
        !frameUrl.pathname.startsWith(prefix)
      ) {
        rejectedBindings++;
        return;
      }
      const packet = Packet.parse(JSON.parse(message.payload));
      if (packet.type === "probe.flushed") {
        entry.flushed.add(message.executionContextId);
        return;
      }
      const event = BrowserContentEventSchema.parse({
        type: packet.type,
        payload: packet.payload,
      });
      if (
        !allowedOrigins.has(new URL(event.payload.url).origin) ||
        !new URL(event.payload.url).pathname.startsWith(prefix)
      ) {
        rejectedBindings++;
        return;
      }
      if (events.length >= 1024) {
        gaps++;
        return;
      }
      entry.participating.add(message.executionContextId);
      events.push({
        sequence: events.length,
        actor,
        type: event.type,
        payload: event.payload,
        frame: entry.contexts.get(message.executionContextId)!,
      });
    } catch {
      rejectedBindings++;
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const tree = await cdp.send("Page.getFrameTree");
  const remember = (node: any) => {
    entry.frames.set(node.frame.id, node.frame.url);
    for (const child of node.childFrames ?? []) remember(child);
  };
  remember(tree.frameTree);
  await cdp.send("Runtime.addBinding", {
    name: bindingName,
    executionContextName: worldName,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `globalThis.__flowcodeProbeConfig=${JSON.stringify({ binding: bindingName, token })};\n${sensor}`,
    worldName,
    runImmediately: true,
  });
}
const report: Record<string, unknown> = {
  schemaVersion: 1,
  cli: connection.cliVersion,
  client: connection.clientVersion,
  kernel: connection.kernelVersion,
  playwright: "1.62.1",
  exactStoreBinding: true,
  discovery:
    "version-bound exact chrome_<storeId> profile + owner PID + owned loopback listener; no arbitrary port scan",
  originalPageCount,
  fixtureTransport:
    "local bytes fulfilled for a unique nonce path on the already authorized site origin; cross-origin fixture uses alternate port; no request to the business server; direct loopback and .test navigation blocked by this client",
};
let page: any;
const browserCdp = await browser.newBrowserCDPSession();
try {
  // Restore the browser's own download policy after the exploratory default-options
  // connection, and request notifications only. Never redirect to Playwright temp.
  await browserCdp.send("Browser.setDownloadBehavior", {
    behavior: "default",
    eventsEnabled: true,
  });
  report.connectionOptions = { noDefaults: true, isLocal: true };
  const extensionProbeDirectory = path.resolve(
    ".stage5a/ziniao-extension-probe",
  );
  await mkdir(extensionProbeDirectory, { recursive: true });
  await writeFile(
    path.join(extensionProbeDirectory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "FlowCode Ziniao transport probe",
      version: "0.0.1",
      permissions: ["nativeMessaging"],
      background: { service_worker: "probe.js" },
    }),
  );
  await writeFile(
    path.join(extensionProbeDirectory, "probe.js"),
    'globalThis.nativeMessagingApiPresent = typeof chrome.runtime.sendNativeMessage === "function";',
  );
  try {
    await browserCdp.send("Extensions.loadUnpacked", {
      path: extensionProbeDirectory,
    });
    report.extensionLoad = "unexpectedly-loaded-review-required";
    throw new Error(
      "Unexpected extension load; stop to avoid duplicate capture.",
    );
  } catch (error) {
    if (/unexpected/i.test(String(error))) throw error;
    report.extensionLoad = {
      status: "unavailable-in-current-launch",
      reason: String(error)
        .replaceAll(extensionProbeDirectory, "<fixture-extension>")
        .slice(0, 500),
    };
  }
  page = await context.newPage();
  await attach(page);
  await page.goto(`${fixtureOrigin}${route("index")}`);
  await page
    .getByRole("textbox", { name: "Customer", exact: true })
    .fill("Fixture customer");
  await page
    .getByLabel("Password", { exact: true })
    .fill("fixture-password-never-export");
  await page.getByLabel("Choice", { exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByLabel("Accepted", { exact: true }).check();
  await page
    .getByRole("button", { name: "Submit fixture", exact: true })
    .click();
  assert.equal(await page.getByRole("status").textContent(), "Fixture success");
  await page
    .frameLocator('iframe[title="Same-origin fixture"]')
    .getByLabel("Frame input")
    .fill("same fixture");
  await page
    .frameLocator('iframe[title="Cross-origin fixture"]')
    .getByLabel("Frame input")
    .fill("cross fixture");
  await page
    .getByRole("button", { name: "Shadow action", exact: true })
    .click();
  const popupPromise = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Open fixture popup", exact: true })
    .click();
  const popup = await popupPromise;
  await attach(popup);
  await popup.getByRole("button", { name: "Popup action" }).click();
  report.popup = "pass";
  // noDefaults preserves real focus: return from the owned popup explicitly.
  await page.bringToFront();
  await page.getByRole("button", { name: "SPA navigation" }).click();
  const file = path.join(out, "upload-fixture.txt");
  await writeFile(file, "synthetic local upload\n");
  const dom = await attached[0].cdp.send("DOM.getDocument");
  const uploadNode = await attached[0].cdp.send("DOM.querySelector", {
    nodeId: dom.root.nodeId,
    selector: 'input[type="file"]',
  });
  await attached[0].cdp.send("DOM.setFileInputFiles", {
    nodeId: uploadNode.nodeId,
    files: [file],
  });
  report.upload = "pass";
  let downloadGuid: string | undefined;
  let completion: { state: string; filePath?: string } | undefined;
  browserCdp.on("Browser.downloadWillBegin", (e: any) => {
    if (
      e.url === `${fixtureOrigin}${route("download")}` &&
      e.suggestedFilename === downloadName
    )
      downloadGuid = e.guid;
  });
  browserCdp.on("Browser.downloadProgress", (e: any) => {
    if (e.guid === downloadGuid && ["completed", "canceled"].includes(e.state))
      completion = e;
  });
  await page.getByRole("link", { name: "Download fixture" }).click();
  const downloadDeadline = Date.now() + 20000;
  while (!completion && Date.now() < downloadDeadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  report.download = {
    state: completion?.state ?? "notification-timeout",
    policy: "browser-default",
  };
  assert.equal(
    completion?.state,
    "completed",
    "Browser-default download did not complete.",
  );
  const allowedDirectory = await realpath(connection.state.downloadFolderPath!);
  const downloadedFile = await realpath(
    completion?.filePath ?? path.join(allowedDirectory, downloadName),
  );
  const relative = path.relative(allowedDirectory, downloadedFile);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Download escaped the CLI-approved directory.",
  );
  const contents = await readFile(downloadedFile, "utf8");
  assert.equal(contents, "id,status\nfixture,success\n");
  await writeFile(path.join(out, "download-fixture.csv"), contents);
  report.downloadImported = "pass";
  report.cliApprovedDownloadDirectory = true;
  const count = events.length;
  assert.ok(
    count > 0,
    `Sensor did not capture: ${JSON.stringify(attached.map((e) => ({ contexts: e.contexts.size, frames: e.frames.size })))}; rejected=${rejectedBindings}`,
  );
  const mainWorldBinding = await page.evaluate(
    ({ bindingName, token }: any) => {
      window.postMessage({ type: "browser.click", token }, "*");
      document
        .querySelector("#human")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return typeof (globalThis as any)[bindingName];
    },
    { bindingName, token },
  );
  assert.equal(mainWorldBinding, "undefined");
  report.pageCannotAccessBinding = true;
  report.syntheticDispatch = {
    eventsBefore: count,
    note: "Main-world dispatch is rejected by isTrusted; pending input flushes are checked separately.",
  };
  await page.screenshot({
    path: path.join(out, "ziniao-local-fixture.png"),
    fullPage: true,
  });
  if (process.argv.includes("--manual")) {
    actor = "human";
    await page.bringToFront();
    console.log(
      "MANUAL_READY: 请在 FlowCode 5A 本地测试页输入测试文字并点击“完成人工验证”。",
    );
    const deadline = Date.now() + 5 * 60 * 1000;
    while (
      Date.now() < deadline &&
      !events.some(
        (e) =>
          e.actor === "human" &&
          e.type === "browser.click" &&
          JSON.stringify(e.payload).includes("完成人工验证"),
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 250));
    report.manualHumanCapture = events.some(
      (e) =>
        e.actor === "human" &&
        e.type === "browser.click" &&
        JSON.stringify(e.payload).includes("完成人工验证"),
    )
      ? "pass"
      : "not-performed";
    actor = "automation";
  } else report.manualHumanCapture = "not-performed";
  await page.getByRole("link", { name: "Navigate fixture" }).click();
  await page.getByRole("button", { name: "After navigation" }).click();
  const flushDiagnostics: unknown[] = [];
  for (const entry of attached)
    for (const id of entry.participating) {
      if (!entry.contexts.has(id)) continue;
      try {
        const r = await entry.cdp.send("Runtime.evaluate", {
          expression: "globalThis.__flowcodeProbeControl?.('stop')",
          contextId: id,
        });
        flushDiagnostics.push({
          exception: Boolean(r.exceptionDetails),
          resultType: r.result?.type,
        });
      } catch {
        gaps++;
      }
    }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const missingFlush = attached.reduce(
    (count, e) =>
      count +
      [...e.participating].filter(
        (id) => e.contexts.has(id) && !e.flushed.has(id),
      ).length,
    0,
  );
  gaps += missingFlush;
  report.flush = missingFlush === 0 ? "pass" : "gap";
  report.flushDiagnostics = flushDiagnostics;
  assert.ok(events.length > 0);
  assert.ok(!JSON.stringify(events).includes("fixture-password-never-export"));
  assert.ok(
    events.some(
      (e) =>
        e.type === "browser.fill" &&
        (e.payload as any).value.kind === "redacted",
    ),
  );
  report.capturedEventCounts = Object.fromEntries(
    [...new Set(events.map((e) => e.type))].map((t) => [
      t,
      events.filter((e) => e.type === t).length,
    ]),
  );
  report.frameCount = new Set(events.map((e) => e.frame)).size;
  report.eventsBounded = true;
  report.passwordBlocked = true;
  report.rejectedBindings = rejectedBindings;
  report.gaps = gaps;
  report.navigationReinjection = events.some(
    (e) =>
      e.type === "browser.click" &&
      JSON.stringify(e.payload).includes("After navigation"),
  );
  assert.equal(
    report.flush,
    "pass",
    "Stop must wait for every active source to flush.",
  );
  report.crossStoreIsolation =
    "scope verified against selected PID and local pages; no events collected from pre-existing/unrelated targets";
  await connection.service.verifyBinding(connection.binding);
} catch (error) {
  report.failure = String(error)
    .replaceAll(fixtureOrigin, "<fixture-origin>")
    .replaceAll(crossOrigin, "<cross-fixture-origin>")
    .replace(/http:\/\/(127\.0\.0\.1|localhost):\d+/g, "<local-fixture>");
  process.exitCode = 1;
} finally {
  for (const entry of attached) await entry.cdp.detach().catch(() => {});
  for (const owned of ownedPages)
    if (!owned.isClosed()) await owned.close().catch(() => {});
  await context.unroute(fixturePattern, fulfillFixture);
  try {
    await browserCdp.send("Browser.setDownloadBehavior", {
      behavior: "default",
      eventsEnabled: false,
    });
    report.downloadPolicyRestored = true;
  } catch {
    report.downloadPolicyRestored = false;
    process.exitCode = 1;
  }
  await browserCdp.detach();
  report.originalPagesPreserved = originalPages.every(
    (p: any) => !p.isClosed(),
  );
  // Playwright close() on a connectOverCDP client disconnects; it does not close the borrowed browser.
  await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await writeFile(
    path.join(out, "ziniao-browser.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
