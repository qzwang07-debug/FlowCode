import {
  BROWSER_BRIDGE_PROTOCOL_VERSION,
  BrowserContentEventSchema,
  BrowserExtensionConfigSchema,
  BrowserSemanticEventSchema,
  BrowserToDesktopMessageSchema,
  ContentToServiceWorkerMessageSchema,
  DesktopToBrowserMessageSchema,
  MAX_BROWSER_MESSAGE_BYTES,
  type BrowserClientCaptureState,
  type BrowserExtensionConfig,
  type BrowserSemanticEvent,
  type BrowserSemanticEventType,
  type BrowserToDesktopMessage,
  type ContentToServiceWorkerMessage,
  type DesktopToBrowserMessage,
  type ServiceWorkerToContentMessage,
} from "../../../../common/browser";
import { sanitizeBrowserUrl } from "../privacy/url";
import { ReliableEventBuffer, type SerializedBrowserBuffer } from "./buffer";
import {
  beginContentSession,
  finishContentSession,
  type ContentSessionState,
} from "./content-session";

interface ChromeEvent<TListener extends (...args: never[]) => unknown> {
  addListener(listener: TListener): void;
}

interface MessageSender {
  id?: string;
  frameId?: number;
  documentId?: string;
  url?: string;
  tab?: ChromeTab;
}

interface ExtensionPort {
  name: string;
  sender?: MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}

interface NativePort extends ExtensionPort {
  sender?: undefined;
}

interface ChromeTab {
  id?: number;
  windowId?: number;
  openerTabId?: number;
  url?: string;
  pendingUrl?: string;
}

interface NavigationDetails {
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
  transitionType?: string;
}

interface DownloadItem {
  id: number;
  url: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
}

interface PendingTab {
  windowId: number;
  openerTabId?: number;
}

declare const chrome: {
  runtime: {
    id: string;
    getManifest(): { version: string };
    getURL(path: string): string;
    connectNative(name: string): NativePort;
    lastError?: { message?: string };
    onConnect: ChromeEvent<(port: ExtensionPort) => void>;
    onMessage: ChromeEvent<
      (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void
    >;
    onStartup: ChromeEvent<() => void>;
    onInstalled: ChromeEvent<() => void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  permissions: {
    getAll(): Promise<{ origins?: string[] }>;
    contains(permissions: { origins: string[] }): Promise<boolean>;
    onAdded: ChromeEvent<() => void>;
    onRemoved: ChromeEvent<() => void>;
  };
  scripting: {
    executeScript(options: {
      target: { tabId: number; allFrames: boolean };
      files: string[];
      injectImmediately?: boolean;
    }): Promise<unknown>;
  };
  tabs: {
    get(tabId: number): Promise<ChromeTab>;
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    onCreated: ChromeEvent<(tab: ChromeTab) => void>;
    onRemoved: ChromeEvent<
      (
        tabId: number,
        removeInfo: { windowId: number; isWindowClosing: boolean },
      ) => void
    >;
    onActivated: ChromeEvent<(activeInfo: { tabId: number }) => void>;
  };
  webNavigation: {
    onCommitted: ChromeEvent<(details: NavigationDetails) => void>;
    onHistoryStateUpdated: ChromeEvent<(details: NavigationDetails) => void>;
    onReferenceFragmentUpdated: ChromeEvent<
      (details: NavigationDetails) => void
    >;
  };
  downloads: {
    onCreated: ChromeEvent<(item: DownloadItem) => void>;
  };
};

const STORAGE_KEY = "flowcode.browser.runtime.v1";
const HEARTBEAT_MS = 10_000;
const RECONNECT_MS = 1_000;
const CAPABILITIES = [
  "browser.document",
  "browser.navigate",
  "browser.click",
  "browser.fill",
  "browser.select",
  "browser.check",
  "browser.submit",
  "browser.tab-open",
  "browser.tab-close",
  "browser.popup",
  "browser.upload",
  "browser.download",
] satisfies BrowserSemanticEventType[];

interface PersistedWorkerState {
  schemaVersion: 1;
  sourceId: string;
  nextSequence: number;
  captureState: BrowserClientCaptureState;
  sessionId: string | null;
  startedAtEpochMs: number | null;
  buffer: SerializedBrowserBuffer;
}

interface ContentConnection extends ContentSessionState {
  port: ExtensionPort;
  tabId: number;
  frameId: number;
  documentId: string | null;
  url: string | null;
  activeSessionId: string | null;
  flushedSessionId: string | null;
}

let config: BrowserExtensionConfig;
let sourceId = "";
let nextSequence = 0;
let captureState: BrowserClientCaptureState = "idle";
let sessionId: string | null = null;
let startedAtEpochMs: number | null = null;
let grantedOriginCount = 0;
let nativePort: NativePort | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = RECONNECT_MS;
let staleSessionTimer: ReturnType<typeof setTimeout> | null = null;
let activatedSessionId: string | null = null;
let saveQueue = Promise.resolve();
let initialized = false;
const sentEvents = new Set<string>();
const contentConnections = new Set<ContentConnection>();
const flushingConnections = new Set<ContentConnection>();
const pendingTabs = new Map<number, PendingTab>();
const authorizedTabs = new Set<number>();
const buffer = new ReliableEventBuffer();

function eventKey(event: BrowserSemanticEvent): string {
  return `${event.sessionId}\0${event.sourceId}\0${event.seq}`;
}

function persistedState(): PersistedWorkerState {
  return {
    schemaVersion: 1,
    sourceId,
    nextSequence,
    captureState,
    sessionId,
    startedAtEpochMs,
    buffer: buffer.serialize(),
  };
}

function saveState(): Promise<void> {
  const snapshot = persistedState();
  saveQueue = saveQueue
    .then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }))
    .catch(() => undefined);
  return saveQueue;
}

function restoreState(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const stored = raw as Partial<PersistedWorkerState>;
  if (stored.schemaVersion !== 1) return;
  if (
    typeof stored.sourceId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stored.sourceId)
  ) {
    sourceId = stored.sourceId;
  }
  if (
    Number.isInteger(stored.nextSequence) &&
    Number(stored.nextSequence) >= 0
  ) {
    nextSequence = Number(stored.nextSequence);
  }
  if (["idle", "recording", "flushing"].includes(stored.captureState ?? "")) {
    captureState = stored.captureState as BrowserClientCaptureState;
  }
  if (
    typeof stored.sessionId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stored.sessionId)
  ) {
    sessionId = stored.sessionId;
  }
  if (typeof stored.startedAtEpochMs === "number") {
    startedAtEpochMs = stored.startedAtEpochMs;
  }
  buffer.restore(stored.buffer);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function postNative(input: BrowserToDesktopMessage): boolean {
  const parsed = BrowserToDesktopMessageSchema.safeParse(input);
  if (!parsed.success || jsonBytes(parsed.data) > MAX_BROWSER_MESSAGE_BYTES)
    return false;
  try {
    nativePort?.postMessage(parsed.data);
    return nativePort !== null;
  } catch {
    return false;
  }
}

function statusFields() {
  return {
    browser: config.browser,
    sourceId,
    extensionVersion: chrome.runtime.getManifest().version,
    captureState,
    sessionId,
    lastSequence: nextSequence - 1,
    bufferedEvents: buffer.size,
    droppedEvents: buffer.droppedEvents,
    grantedOriginCount,
  } as const;
}

async function refreshPermissions(): Promise<void> {
  const permissions = await chrome.permissions.getAll();
  grantedOriginCount = (permissions.origins ?? []).filter(
    (origin) => origin.startsWith("http://") || origin.startsWith("https://"),
  ).length;
}

async function sendHello(): Promise<void> {
  await refreshPermissions();
  postNative({
    kind: "browser.hello",
    protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
    ...statusFields(),
    capabilities: CAPABILITIES,
  });
}

function sendHeartbeat(): void {
  if (!initialized || !nativePort) return;
  postNative({
    kind: "browser.heartbeat",
    protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
    ...statusFields(),
    epochMs: Date.now(),
  });
}

function sendPendingEvents(): void {
  if (!nativePort) return;
  for (const event of buffer.pending()) {
    const key = eventKey(event);
    if (sentEvents.has(key)) continue;
    if (
      postNative({
        kind: "browser.event",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        event,
      })
    ) {
      sentEvents.add(key);
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
}

function connectNative(): void {
  if (!initialized || nativePort) return;
  let port: NativePort;
  try {
    port = chrome.runtime.connectNative(config.nativeHost);
  } catch {
    scheduleReconnect();
    return;
  }
  nativePort = port;
  sentEvents.clear();
  port.onMessage.addListener((raw) => {
    const parsed = DesktopToBrowserMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    reconnectDelayMs = RECONNECT_MS;
    void handleDesktopMessage(parsed.data);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError?.message;
    if (nativePort === port) nativePort = null;
    sentEvents.clear();
    scheduleReconnect();
  });
  postNative({
    kind: "state.get",
    protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
  });
  void sendHello().then(sendPendingEvents);
}

function contentMessage(
  connection: ContentConnection,
  message: ServiceWorkerToContentMessage,
): void {
  try {
    connection.port.postMessage(message);
  } catch {
    contentConnections.delete(connection);
  }
}

function activateContent(connection: ContentConnection): void {
  if (!sessionId || captureState === "idle") return;
  if (!beginContentSession(connection, sessionId)) return;
  contentMessage(connection, { kind: "record.start", sessionId });
}

function deactivateAllContent(stoppingSessionId: string): void {
  flushingConnections.clear();
  for (const connection of contentConnections) {
    if (connection.activeSessionId !== stoppingSessionId) continue;
    flushingConnections.add(connection);
    contentMessage(connection, {
      kind: "record.stop",
      sessionId: stoppingSessionId,
    });
  }
}

function sessionPendingCount(activeSessionId: string): number {
  return buffer.pending().filter((event) => event.sessionId === activeSessionId)
    .length;
}

function tryFinishFlush(): void {
  if (captureState !== "flushing" || !sessionId) return;
  const stoppingSessionId = sessionId;
  const contentPending = [...flushingConnections].some(
    (connection) => connection.flushedSessionId !== stoppingSessionId,
  );
  if (contentPending || sessionPendingCount(stoppingSessionId) > 0) return;
  postNative({
    kind: "browser.flushed",
    protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
    browser: config.browser,
    sourceId,
    sessionId: stoppingSessionId,
    lastSequence: nextSequence - 1,
    droppedEvents: buffer.droppedEvents,
  });
  captureState = "idle";
  sessionId = null;
  activatedSessionId = null;
  startedAtEpochMs = null;
  flushingConnections.clear();
  pendingTabs.clear();
  authorizedTabs.clear();
  void saveState();
}

async function beginCapture(
  nextSessionId: string,
  startedAt: number,
): Promise<void> {
  if (
    sessionId === nextSessionId &&
    captureState === "recording" &&
    activatedSessionId === nextSessionId
  ) {
    return;
  }
  if (sessionId && sessionId !== nextSessionId) buffer.clearSession(sessionId);
  sessionId = nextSessionId;
  activatedSessionId = nextSessionId;
  pendingTabs.clear();
  authorizedTabs.clear();
  startedAtEpochMs = startedAt;
  captureState = "recording";
  if (staleSessionTimer) {
    clearTimeout(staleSessionTimer);
    staleSessionTimer = null;
  }
  await saveState();
  for (const tab of await chrome.tabs.query({})) {
    if (typeof tab.id === "number") void ensureContentScript(tab.id);
  }
  for (const connection of contentConnections) activateContent(connection);
  sendHeartbeat();
}

function stopCapture(stoppingSessionId: string, deadlineEpochMs: number): void {
  if (sessionId !== stoppingSessionId || captureState === "idle") return;
  captureState = "flushing";
  deactivateAllContent(stoppingSessionId);
  void saveState();
  tryFinishFlush();
  const delay = Math.max(0, deadlineEpochMs - Date.now() + 1000);
  if (staleSessionTimer) clearTimeout(staleSessionTimer);
  staleSessionTimer = setTimeout(() => {
    if (sessionId !== stoppingSessionId || captureState !== "flushing") return;
    buffer.clearSession(stoppingSessionId);
    captureState = "idle";
    sessionId = null;
    activatedSessionId = null;
    startedAtEpochMs = null;
    flushingConnections.clear();
    pendingTabs.clear();
    authorizedTabs.clear();
    void saveState();
  }, delay);
}

function acknowledge(
  message: Extract<DesktopToBrowserMessage, { kind: "browser.ack" }>,
): void {
  if (buffer.acknowledge(message.sessionId, message.sourceId, message.seq)) {
    sentEvents.delete(
      `${message.sessionId}\0${message.sourceId}\0${message.seq}`,
    );
    void saveState();
  }
  tryFinishFlush();
}

async function handleDesktopMessage(
  message: DesktopToBrowserMessage,
): Promise<void> {
  switch (message.kind) {
    case "desktop.hello":
      await sendHello();
      sendPendingEvents();
      break;
    case "record.state":
      if (message.state === "recording") {
        await beginCapture(message.sessionId, message.startedAtEpochMs);
      } else if (sessionId) {
        const stale = sessionId;
        deactivateAllContent(stale);
        buffer.clearSession(stale);
        captureState = "idle";
        sessionId = null;
        activatedSessionId = null;
        startedAtEpochMs = null;
        flushingConnections.clear();
        pendingTabs.clear();
        authorizedTabs.clear();
        await saveState();
      }
      break;
    case "record.start":
      await beginCapture(message.sessionId, message.startedAtEpochMs);
      break;
    case "record.stop":
      stopCapture(message.sessionId, message.deadlineEpochMs);
      break;
    case "browser.ack":
      acknowledge(message);
      break;
    case "browser.ping":
      postNative({
        kind: "browser.pong",
        protocolVersion: BROWSER_BRIDGE_PROTOCOL_VERSION,
        nonce: message.nonce,
        epochMs: Date.now(),
        monotonicMs: performance.timeOrigin + performance.now(),
      });
      break;
    case "bridge.error":
      if (message.code === "invalid-session" && sessionId) {
        buffer.clearSession(sessionId);
      }
      break;
  }
}

function createSemanticEvent(
  type: BrowserSemanticEventType,
  payload: unknown,
  epochMs = Date.now(),
  monotonicMs = performance.timeOrigin + performance.now(),
): BrowserSemanticEvent | null {
  if (captureState !== "recording" || !sessionId) return null;
  const payloadRecord =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  const capturedValue =
    typeof payloadRecord?.value === "object" && payloadRecord.value !== null
      ? (payloadRecord.value as Record<string, unknown>)
      : null;
  const privacyTags =
    type === "browser.fill" &&
    capturedValue?.kind === "redacted" &&
    typeof capturedValue.reason === "string"
      ? [`redacted:${capturedValue.reason}`]
      : undefined;
  const parsed = BrowserSemanticEventSchema.safeParse({
    schemaVersion: 1,
    eventId: `evt-${crypto.randomUUID()}`,
    sessionId,
    sourceId,
    source: "browser",
    seq: nextSequence,
    epochMs,
    monotonicMs,
    type,
    payload,
    ...(privacyTags ? { privacyTags } : {}),
  });
  if (!parsed.success) return null;
  nextSequence += 1;
  const result = buffer.enqueue(parsed.data);
  void saveState();
  if (result.accepted) sendPendingEvents();
  else sendHeartbeat();
  if (result.dropped > 0) {
    const pendingKeys = new Set(buffer.pending().map(eventKey));
    for (const key of sentEvents) {
      if (!pendingKeys.has(key)) sentEvents.delete(key);
    }
  }
  return parsed.data;
}

function handleContentMessage(
  connection: ContentConnection,
  raw: unknown,
): void {
  const parsed = ContentToServiceWorkerMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const message: ContentToServiceWorkerMessage = parsed.data;
  if (message.kind === "content.hello") {
    connection.documentId = message.documentId;
    connection.url = sanitizeBrowserUrl(
      connection.port.sender?.url ?? message.url,
    );
    activateContent(connection);
    return;
  }
  if (message.kind === "content.flushed") {
    if (message.sessionId === sessionId)
      finishContentSession(connection, message.sessionId);
    tryFinishFlush();
    return;
  }
  if (captureState !== "recording" || !sessionId) return;
  const contentEvent = BrowserContentEventSchema.safeParse(message.event);
  if (!contentEvent.success) return;
  const senderUrl = sanitizeBrowserUrl(
    connection.port.sender?.url ??
      connection.url ??
      contentEvent.data.payload.url,
  );
  if (!senderUrl) return;
  const documentId =
    connection.port.sender?.documentId ?? connection.documentId;
  if (!documentId) return;
  const payload = {
    ...contentEvent.data.payload,
    tabId: connection.tabId,
    frameId: connection.frameId,
    documentId,
    url: senderUrl,
  };
  createSemanticEvent(
    contentEvent.data.type,
    payload,
    message.epochMs,
    message.monotonicMs,
  );
}

function onContentConnect(port: ExtensionPort): void {
  const sender = port.sender;
  if (
    port.name !== "flowcode-content-v1" ||
    sender?.id !== chrome.runtime.id ||
    typeof sender.tab?.id !== "number" ||
    !sanitizeBrowserUrl(sender.url ?? sender.tab.url ?? "")
  ) {
    port.disconnect();
    return;
  }
  const connection: ContentConnection = {
    port,
    tabId: sender.tab.id,
    frameId: sender.frameId ?? 0,
    documentId: sender.documentId ?? null,
    url: sanitizeBrowserUrl(sender.url ?? sender.tab.url ?? ""),
    activeSessionId: null,
    flushedSessionId: null,
  };
  contentConnections.add(connection);
  port.onMessage.addListener((message) =>
    handleContentMessage(connection, message),
  );
  port.onDisconnect.addListener(() => {
    contentConnections.delete(connection);
    flushingConnections.delete(connection);
    tryFinishFlush();
  });
  activateContent(connection);
}

async function hasOriginPermission(rawUrl: string): Promise<boolean> {
  const url = sanitizeBrowserUrl(rawUrl);
  if (!url) return false;
  return chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const rawUrl = tab.url ?? tab.pendingUrl ?? "";
    if (!(await hasOriginPermission(rawUrl))) return false;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content-script.js"],
      injectImmediately: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function reconcileContentPermissions(): Promise<void> {
  for (const connection of contentConnections) {
    const permitted = connection.url
      ? await hasOriginPermission(connection.url)
      : false;
    if (permitted) {
      activateContent(connection);
    } else if (sessionId && connection.activeSessionId === sessionId) {
      contentMessage(connection, { kind: "record.stop", sessionId });
    }
  }
  if (captureState === "recording") {
    for (const tab of await chrome.tabs.query({})) {
      if (typeof tab.id === "number") void ensureContentScript(tab.id);
    }
  }
}

function navigationKind(details: NavigationDetails): "document" | "reload" {
  return details.transitionType === "reload" ? "reload" : "document";
}

function recordNavigation(
  details: NavigationDetails,
  kind: "document" | "history" | "fragment" | "reload",
): void {
  const url = sanitizeBrowserUrl(details.url);
  if (!url) return;
  void hasOriginPermission(url).then((permitted) => {
    if (!permitted) return;
    const pending = pendingTabs.get(details.tabId);
    if (pending && !authorizedTabs.has(details.tabId)) {
      authorizedTabs.add(details.tabId);
      createSemanticEvent("browser.tab-open", {
        tabId: details.tabId,
        windowId: pending.windowId,
        ...(pending.openerTabId !== undefined
          ? { openerTabId: pending.openerTabId }
          : {}),
        url,
      });
      if (pending.openerTabId !== undefined) {
        createSemanticEvent("browser.popup", {
          tabId: details.tabId,
          windowId: pending.windowId,
          openerTabId: pending.openerTabId,
          url,
        });
      }
    }
    pendingTabs.delete(details.tabId);
    createSemanticEvent("browser.navigate", {
      tabId: details.tabId,
      frameId: details.frameId,
      documentId:
        details.documentId ??
        `tab-${details.tabId}-frame-${details.frameId}-${Date.now()}`,
      url,
      navigationKind: kind,
    });
    void ensureContentScript(details.tabId);
  });
}

function basename(raw: string): string | undefined {
  const normalized = raw.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
  return name ? name.slice(0, 512) : undefined;
}

function installChromeListeners(): void {
  chrome.runtime.onConnect.addListener(onContentConnect);
  chrome.tabs.onCreated.addListener((tab) => {
    if (captureState !== "recording" || typeof tab.id !== "number") return;
    pendingTabs.set(tab.id, {
      windowId: tab.windowId ?? -1,
      ...(typeof tab.openerTabId === "number"
        ? { openerTabId: tab.openerTabId }
        : {}),
    });
    const url = sanitizeBrowserUrl(tab.pendingUrl ?? tab.url ?? "");
    if (!url) return;
    void hasOriginPermission(url).then((permitted) => {
      if (!permitted || !pendingTabs.has(tab.id as number)) return;
      recordNavigation(
        {
          tabId: tab.id as number,
          frameId: 0,
          url,
          transitionType: "unknown",
        },
        "document",
      );
    });
  });
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    pendingTabs.delete(tabId);
    if (authorizedTabs.delete(tabId)) {
      createSemanticEvent("browser.tab-close", {
        tabId,
        windowId: removeInfo.windowId,
        isWindowClosing: removeInfo.isWindowClosing,
      });
    }
  });
  chrome.webNavigation.onCommitted.addListener((details) =>
    recordNavigation(details, navigationKind(details)),
  );
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) =>
    recordNavigation(details, "history"),
  );
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) =>
    recordNavigation(details, "fragment"),
  );
  chrome.downloads.onCreated.addListener((item) => {
    const url = sanitizeBrowserUrl(item.finalUrl ?? item.url);
    if (!url) return;
    void hasOriginPermission(url).then((permitted) => {
      if (!permitted) return;
      createSemanticEvent("browser.download", {
        downloadId: item.id,
        tabId: null,
        url,
        ...(basename(item.filename ?? "")
          ? { suggestedFilename: basename(item.filename ?? "") }
          : {}),
        ...(item.mime ? { mime: item.mime.slice(0, 128) } : {}),
      });
    });
  });
  chrome.permissions.onAdded.addListener(() => {
    void refreshPermissions().then(reconcileContentPermissions).then(sendHello);
  });
  chrome.permissions.onRemoved.addListener(() => {
    void refreshPermissions().then(reconcileContentPermissions).then(sendHello);
  });
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !raw || typeof raw !== "object")
      return;
    const kind = (raw as { kind?: unknown }).kind;
    if (kind === "popup.status") {
      void (async () => {
        await refreshPermissions();
        sendResponse({
          ok: true,
          connected: nativePort !== null,
          browser: config.browser,
          captureState,
          grantedOriginCount,
          bufferedEvents: buffer.size,
          droppedEvents: buffer.droppedEvents,
        });
      })();
      return true;
    }
    if (kind === "permission.refresh") {
      const tabId = (raw as { tabId?: unknown }).tabId;
      void (async () => {
        await refreshPermissions();
        const injected =
          typeof tabId === "number" ? await ensureContentScript(tabId) : false;
        await sendHello();
        sendResponse({ ok: true, injected });
      })();
      return true;
    }
  });
}

async function loadConfig(): Promise<BrowserExtensionConfig> {
  const response = await fetch(chrome.runtime.getURL("browser-config.json"));
  if (!response.ok)
    throw new Error("FlowCode browser configuration is missing.");
  return BrowserExtensionConfigSchema.parse(await response.json());
}

async function initialize(): Promise<void> {
  config = await loadConfig();
  if (config.extensionId !== chrome.runtime.id) {
    throw new Error(
      "FlowCode extension ID does not match its browser configuration.",
    );
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  restoreState(stored[STORAGE_KEY]);
  if (!sourceId) sourceId = `${config.browser}-${crypto.randomUUID()}`;
  await refreshPermissions();
  initialized = true;
  await saveState();
  installChromeListeners();
  connectNative();
  setInterval(sendHeartbeat, HEARTBEAT_MS);
}

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);
void initialize();
