import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createZiniaoTransport,
  detectZiniaoCli,
  ZiniaoCliService,
  ziniaoConfigFingerprint,
} from "../../electron/ziniao/cli-service";
import { discoverZiniaoEndpoint } from "../../electron/ziniao/endpoint-discovery";

const storeName = process.env.FLOWCODE_TEST_STORE_NAME;
if (!storeName)
  throw new Error("Set FLOWCODE_TEST_STORE_NAME to the approved test store name.");
const candidateClientVersion = process.env.FLOWCODE_TEST_CLIENT_VERSION;
if (!candidateClientVersion)
  throw new Error("Set FLOWCODE_TEST_CLIENT_VERSION for the scoped compatibility probe.");
const repository = path.resolve(".");
const runtimeRoot = path.resolve(".stage5b", "fixture-host");
const evidenceRoot = path.resolve(".stage5b", "evidence");
if (!runtimeRoot.startsWith(repository + path.sep))
  throw new Error("Fixture root escaped the repository.");
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });
await mkdir(evidenceRoot, { recursive: true });
const uploadFile = path.join(evidenceRoot, "upload-fixture.txt");
await writeFile(uploadFile, "FlowCode 5B synthetic upload fixture\n", "utf8");

const cli = await detectZiniaoCli(
  path.join(
    process.env.APPDATA!,
    "npm",
    "node_modules",
    "@ziniao-open",
    "cli",
    "bin",
    "ziniao-cli.exe",
  ),
);
const service = new ZiniaoCliService(
  createZiniaoTransport(cli.binary),
  ziniaoConfigFingerprint(
    path.join(process.env.USERPROFILE!, ".ziniao-cli", "config.json"),
  ),
);
const binding = await service.bindName(storeName);
const running = await service.ensureVisibleRunning(binding);
const endpoint = await discoverZiniaoEndpoint({
  binding,
  service,
  allowedClientVersions: [candidateClientVersion],
});
const playwrightPackage = path.resolve(
  ".stage5a",
  "tools",
  "node_modules",
  "playwright",
  "index.mjs",
);
const { chromium } = await import(pathToFileURL(playwrightPackage).href);
const browser = await chromium.connectOverCDP(endpoint.endpoint, {
  noDefaults: true,
  isLocal: true,
});
const context = browser.contexts()[0];
if (!context) throw new Error("The selected store has no existing browser context.");
const originalPages = context.pages();
const existing = originalPages.find((page: any) => /^https:\/\//.test(page.url()));
if (!existing)
  throw new Error("The approved store needs one existing HTTPS page for local fixture transport.");
const fixtureOrigin = new URL(existing.url()).origin;
const cross = new URL(fixtureOrigin);
cross.port = cross.port === "8443" ? "9443" : "8443";
const crossOrigin = cross.origin;
const nonce = randomBytes(12).toString("hex");
const prefix = `/flowcode-5b-${nonce}`;
const downloadName = `flowcode-5b-${nonce}.csv`;
const route = (name: string) => `${prefix}/${name}`;

const server = createServer((request, response) => {
  if (!request.url?.startsWith(prefix)) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (request.url === route("download")) {
    response.writeHead(200, {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${downloadName}"`,
    });
    response.end("id,status\nflowcode-5b,success\n");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === route("frame")) {
    response.end(`<!doctype html><html lang="zh-CN"><body>
      <label>iframe 测试输入<input aria-label="iframe 测试输入"></label>
    </body></html>`);
    return;
  }
  if (request.url === route("popup")) {
    response.end(`<!doctype html><html lang="zh-CN"><body>
      <h1>FlowCode 5B Popup</h1><button id="popup-complete">确认 Popup</button>
      <p role="status"></p><script>document.querySelector('#popup-complete').onclick=()=>{document.body.dataset.complete='true';document.querySelector('[role=status]').textContent='Popup 已确认'};</script>
    </body></html>`);
    return;
  }
  response.end(`<!doctype html><html lang="zh-CN"><head><title>FlowCode 5B 本地验收</title>
  <style>body{font-family:system-ui;padding:24px;max-width:760px;margin:auto}label{display:block;margin:12px 0}input,select,button,a{font:inherit;padding:7px;margin:4px}code{display:block;padding:8px;background:#eee;overflow-wrap:anywhere}iframe{width:100%;min-height:90px;border:1px solid #999}</style></head><body>
  <h1>FlowCode 5B 本地语义录制验收</h1><p>本页全部为本地 Fixture，不访问或修改店铺业务数据。</p>
  <form id="fixture-form"><label>人工验证输入<input aria-label="人工验证输入"></label>
  <label>验证选项<select aria-label="验证选项"><option value="one">选项一</option><option value="two">选项二</option></select></label>
  <label><input type="checkbox" aria-label="我已确认">我已确认</label>
  <label>测试文件<input type="file" aria-label="测试文件"></label><p>上传文件路径：</p><code>${uploadFile.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code>
  <button type="submit">提交本地测试</button></form><p role="status"></p>
  <button id="popup">打开本地 Popup</button><button id="spa">切换本地步骤</button>
  <a href="${route("download")}" download>下载本地结果</a>
  <iframe title="同源 iframe" src="${route("frame")}"></iframe>
  <iframe title="跨源 iframe" src="${crossOrigin}${route("frame")}"></iframe>
  <div id="shadow"></div>
  <script>
  document.querySelector('#fixture-form').onsubmit=(event)=>{event.preventDefault();document.body.dataset.submitted='true';document.querySelector('[role=status]').textContent='本地提交成功'};
  document.querySelector('#popup').onclick=()=>window.open('${route("popup")}');
  document.querySelector('#spa').onclick=()=>{history.pushState({},'',location.pathname+'#step-2');document.body.dataset.spa='true'};
  document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-action">Shadow 操作</button>';
  </script></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const allowedOrigins = new Set([fixtureOrigin, crossOrigin]);
const fixturePattern = (url: URL) =>
  allowedOrigins.has(url.origin) && url.pathname.startsWith(prefix + "/");
const fulfill = async (routeRequest: any) => {
  const url = new URL(routeRequest.request().url());
  const local = await fetch(`http://127.0.0.1:${port}${url.pathname}`);
  await routeRequest.fulfill({
    status: local.status,
    headers: Object.fromEntries(local.headers.entries()),
    body: Buffer.from(await local.arrayBuffer()),
  });
};
await context.route(fixturePattern, fulfill);
const page = await context.newPage();
const ownedPages = new Set<any>([page]);
page.on("popup", (popup: any) => ownedPages.add(popup));
let downloadCount = 0;
let downloadContentVerified = false;
page.on("download", async (download: any) => {
  downloadCount += 1;
  try {
    const downloaded = await download.path();
    if (downloaded) {
      const contents = await readFile(downloaded, "utf8");
      downloadContentVerified = contents === "id,status\nflowcode-5b,success\n";
    }
  } catch {
    downloadContentVerified = false;
  }
});
await page.goto(`${fixtureOrigin}${route("index")}`);
await page.bringToFront();
await writeFile(
  path.join(runtimeRoot, "ready.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      storeName,
      pageTitle: "FlowCode 5B 本地验收",
      fixturePath: prefix.slice(1),
      uploadFile,
      crossOriginFrame: true,
      launchOwnership: running.launchOwnership,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log("STAGE5B_FIXTURE_READY");
console.log(`Store: ${storeName}`);
console.log("Page: FlowCode 5B 本地验收");
console.log(`Upload fixture: ${uploadFile}`);
console.log("Keep this process running until FlowCode recording has stopped.");

await new Promise<void>((resolve) => {
  const finish = () => resolve();
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
});

let mainState: Record<string, unknown> = {};
let frameInputs = 0;
let popupComplete = false;
try {
  mainState = await page.evaluate(() => ({
    submitted: document.body.dataset.submitted === "true",
    spa: document.body.dataset.spa === "true",
    uploadCount:
      (document.querySelector('input[type="file"]') as HTMLInputElement | null)
        ?.files?.length ?? 0,
    inputLength:
      (document.querySelector('[aria-label="人工验证输入"]') as HTMLInputElement | null)
        ?.value.length ?? 0,
  }));
  for (const frame of page.frames().filter((item: any) => item !== page.mainFrame())) {
    const value = await frame
      .locator('[aria-label="iframe 测试输入"]')
      .inputValue()
      .catch(() => "");
    if (value) frameInputs += 1;
  }
  for (const owned of ownedPages) {
    if (owned === page || owned.isClosed()) continue;
    popupComplete ||= await owned
      .evaluate(() => document.body.dataset.complete === "true")
      .catch(() => false);
  }
} catch {
  // The receipt below reports incomplete checks rather than promoting them.
}
const originalPagesPreserved = originalPages.every((item: any) => !item.isClosed());
const receipt = {
  schemaVersion: 1,
  storeName: "<approved-test-store>",
  cliVersion: cli.version,
  clientVersion: endpoint.clientVersion,
  kernelVersion: endpoint.kernelVersion,
  fixtureOnly: true,
  submitted: mainState.submitted === true,
  spa: mainState.spa === true,
  humanInputPresent:
    typeof mainState.inputLength === "number" && mainState.inputLength > 0,
  uploadSelected:
    typeof mainState.uploadCount === "number" && mainState.uploadCount > 0,
  iframeInputs: frameInputs,
  popupComplete,
  downloadCount,
  downloadContentVerified,
  originalPagesPreserved,
  fixtureHash: createHash("sha256")
    .update(await readFile(uploadFile))
    .digest("hex"),
};
await writeFile(
  path.join(evidenceRoot, "ziniao-fixture-host.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
for (const owned of ownedPages)
  if (!owned.isClosed()) await owned.close().catch(() => undefined);
await context.unroute(fixturePattern, fulfill);
await browser.close();
server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
assert.equal(originalPagesPreserved, true);
console.log(JSON.stringify(receipt, null, 2));
