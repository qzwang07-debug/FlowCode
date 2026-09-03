interface PopupTab {
  id?: number;
  url?: string;
}

declare const chrome: {
  runtime: {
    lastError?: { message?: string };
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: {
    query(query: {
      active?: boolean;
      currentWindow: boolean;
    }): Promise<PopupTab[]>;
  };
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
    request(permissions: { origins: string[] }): Promise<boolean>;
  };
};

interface PopupStatus {
  ok: true;
  connected: boolean;
  browser: "chrome" | "edge";
  captureState: "idle" | "recording" | "flushing";
  grantedOriginCount: number;
  bufferedEvents: number;
  droppedEvents: number;
}

const desktopStatus = requiredElement("desktop-status");
const captureStatus = requiredElement("capture-status");
const siteStatus = requiredElement("site-status");
const browserName = requiredElement("browser-name");
const description = requiredElement("site-description");
const message = requiredElement("message");
const allowButton = requiredElement("allow-site") as HTMLButtonElement;

let activeTabId: number | null = null;
let activeOriginPattern: string | null = null;

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element;
}

function originPattern(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

function isPopupStatus(value: unknown): value is PopupStatus {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { connected?: unknown }).connected === "boolean"
  );
}

async function render(): Promise<void> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const tab =
    tabs.find(
      (candidate) => candidate.id !== undefined && originPattern(candidate.url),
    ) ?? tabs.find((candidate) => candidate.id !== undefined);
  activeTabId = typeof tab?.id === "number" ? tab.id : null;
  activeOriginPattern = originPattern(tab?.url);
  if (activeOriginPattern) {
    description.textContent = `Allow ${activeOriginPattern.slice(0, -2)} for FlowCode recordings. Password and payment fields are never saved.`;
  }
  const status = await chrome.runtime.sendMessage({ kind: "popup.status" });
  if (isPopupStatus(status)) {
    browserName.textContent = `${status.browser === "edge" ? "Edge" : "Chrome"} semantic capture`;
    desktopStatus.textContent = status.connected
      ? "Connected"
      : "Not connected";
    captureStatus.textContent =
      status.captureState === "recording"
        ? "Recording"
        : status.captureState === "flushing"
          ? "Finishing"
          : "Idle";
  }
  if (!activeOriginPattern) {
    siteStatus.textContent = "Unavailable";
    description.textContent =
      "Open an http or https page to grant recording access.";
    allowButton.disabled = true;
    return;
  }
  const granted = await chrome.permissions.contains({
    origins: [activeOriginPattern],
  });
  siteStatus.textContent = granted ? "Allowed" : "Not allowed";
  allowButton.textContent = granted ? "Site allowed" : "Allow this site";
  allowButton.disabled = granted;
}

allowButton.addEventListener("click", async () => {
  if (!activeOriginPattern || activeTabId === null) return;
  allowButton.disabled = true;
  message.className = "message";
  message.textContent = "Requesting access…";
  try {
    const granted = await chrome.permissions.request({
      origins: [activeOriginPattern],
    });
    if (!granted) {
      message.textContent = "Access was not granted.";
      allowButton.disabled = false;
      return;
    }
    await chrome.runtime.sendMessage({
      kind: "permission.refresh",
      tabId: activeTabId,
    });
    message.textContent = "This site can now join FlowCode recordings.";
    await render();
  } catch (error) {
    message.className = "message error";
    message.textContent =
      error instanceof Error ? error.message : String(error);
    allowButton.disabled = false;
  }
});

void render().catch((error) => {
  message.className = "message error";
  message.textContent = error instanceof Error ? error.message : String(error);
});
