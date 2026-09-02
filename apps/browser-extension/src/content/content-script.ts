import {
  ServiceWorkerToContentMessageSchema,
  type BrowserContentEvent,
  type ContentToServiceWorkerMessage,
} from "../../../../common/browser";
import {
  buildLocatorCandidates,
  summarizeTarget,
  targetFromEvent,
} from "../locator/dom-locator";
import { captureFieldValue, safeUploadMetadata } from "../privacy";
import { sanitizeBrowserUrl } from "../privacy/url";

interface RuntimePort {
  postMessage(message: ContentToServiceWorkerMessage): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

declare const chrome: {
  runtime: {
    connect(options: { name: string }): RuntimePort;
  };
};

interface FlowCodeContentGlobal {
  __flowcodeContentScriptV1?: boolean;
}

const globalState = globalThis as typeof globalThis & FlowCodeContentGlobal;

if (!globalState.__flowcodeContentScriptV1) {
  globalState.__flowcodeContentScriptV1 = true;
  startContentSensor();
}

function startContentSensor(): void {
  const documentId = crypto.randomUUID();
  const pendingInputs = new Map<Element, number>();
  let activeSessionId: string | null = null;
  let port: RuntimePort | null = null;
  let lastUrl = location.href;
  let reconnectTimer: number | null = null;
  let lastPointerDown: { element: Element; epochMs: number } | null = null;

  const post = (message: ContentToServiceWorkerMessage): void => {
    try {
      port?.postMessage(message);
    } catch {
      // The service worker will be reconnected; event buffers live there.
    }
  };

  const sendEvent = (event: BrowserContentEvent): void => {
    if (!activeSessionId || !/^https?:$/.test(location.protocol)) return;
    post({
      kind: "content.event",
      epochMs: Date.now(),
      monotonicMs: performance.timeOrigin + performance.now(),
      event,
    });
  };

  const eventContext = () => ({
    documentId,
    url: sanitizeBrowserUrl(location.href) ?? "https://invalid.flowcode.local/",
  });

  const describe = (element: Element) => ({
    target: summarizeTarget(element),
    locators: buildLocatorCandidates(element),
  });

  const fieldValue = (element: Element): string | null => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return element.value;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.textContent ?? "";
    }
    return null;
  };

  const publishFill = (element: Element): void => {
    const timer = pendingInputs.get(element);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingInputs.delete(element);
    const rawValue = fieldValue(element);
    if (rawValue === null) return;
    const target = summarizeTarget(element);
    sendEvent({
      type: "browser.fill",
      payload: {
        ...eventContext(),
        target,
        locators: buildLocatorCandidates(element),
        value: captureFieldValue(rawValue, {
          inputType: target.inputType,
          autocomplete: target.autocomplete,
          name: element.getAttribute("name"),
          id: element.id,
          ariaLabel: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
        }),
      },
    });
  };

  const flushInputs = (): void => {
    for (const element of [...pendingInputs.keys()]) publishFill(element);
  };

  const scheduleFill = (element: Element): void => {
    const previous = pendingInputs.get(element);
    if (previous !== undefined) window.clearTimeout(previous);
    const timer = window.setTimeout(() => publishFill(element), 350);
    pendingInputs.set(element, timer);
  };

  const onClick = (event: MouseEvent): void => {
    if (!activeSessionId || !event.isTrusted) return;
    const clickTarget = targetFromEvent(event);
    const element =
      lastPointerDown && Date.now() - lastPointerDown.epochMs < 2000
        ? lastPointerDown.element
        : clickTarget;
    lastPointerDown = null;
    if (!element) return;
    const modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
    if (event.altKey) modifiers.push("Alt");
    if (event.ctrlKey) modifiers.push("Control");
    if (event.metaKey) modifiers.push("Meta");
    if (event.shiftKey) modifiers.push("Shift");
    sendEvent({
      type: "browser.click",
      payload: {
        ...eventContext(),
        ...describe(element),
        button: event.button,
        modifiers,
      },
    });
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!activeSessionId || !event.isTrusted) return;
    const element = targetFromEvent(event);
    if (element) lastPointerDown = { element, epochMs: Date.now() };
  };

  const onInput = (event: Event): void => {
    if (!activeSessionId || !event.isTrusted) return;
    const element = targetFromEvent(event);
    if (!element) return;
    if (element instanceof HTMLInputElement) {
      if (
        element.type === "checkbox" ||
        element.type === "radio" ||
        element.type === "file"
      ) {
        return;
      }
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable)
    ) {
      scheduleFill(element);
    }
  };

  const onChange = (event: Event): void => {
    if (!activeSessionId || !event.isTrusted) return;
    const element = targetFromEvent(event);
    if (!element) return;
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        sendEvent({
          type: "browser.check",
          payload: {
            ...eventContext(),
            ...describe(element),
            checked: element.checked,
          },
        });
        return;
      }
      if (element.type === "file" && element.files?.length) {
        sendEvent({
          type: "browser.upload",
          payload: {
            ...eventContext(),
            ...describe(element),
            ...safeUploadMetadata([...element.files]),
          },
        });
        return;
      }
    }
    if (element instanceof HTMLSelectElement) {
      sendEvent({
        type: "browser.select",
        payload: {
          ...eventContext(),
          ...describe(element),
          options: [...element.selectedOptions].slice(0, 50).map((option) => ({
            value: option.value.slice(0, 512),
            label: (option.label || option.textContent || "").slice(0, 512),
          })),
        },
      });
      return;
    }
    publishFill(element);
  };

  const onBlur = (event: FocusEvent): void => {
    if (!activeSessionId || !event.isTrusted) return;
    const element = targetFromEvent(event);
    if (element && pendingInputs.has(element)) publishFill(element);
  };

  const onSubmit = (event: SubmitEvent): void => {
    if (!activeSessionId || !event.isTrusted) return;
    flushInputs();
    const form = targetFromEvent(event);
    if (!form) return;
    sendEvent({
      type: "browser.submit",
      payload: { ...eventContext(), ...describe(form) },
    });
  };

  const activate = (sessionId: string): void => {
    if (activeSessionId === sessionId) return;
    activeSessionId = sessionId;
    lastUrl = location.href;
    post({ kind: "content.hello", documentId, url: eventContext().url });
    sendEvent({
      type: "browser.document",
      payload: {
        ...eventContext(),
        title: document.title.slice(0, 1024),
        ...(sanitizeBrowserUrl(document.referrer)
          ? { referrer: sanitizeBrowserUrl(document.referrer) ?? undefined }
          : {}),
      },
    });
  };

  const deactivate = (sessionId: string): void => {
    if (activeSessionId !== sessionId) return;
    flushInputs();
    activeSessionId = null;
    post({ kind: "content.flushed", sessionId });
  };

  const connect = (): void => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const next = chrome.runtime.connect({ name: "flowcode-content-v1" });
    port = next;
    next.onMessage.addListener((raw) => {
      const parsed = ServiceWorkerToContentMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.kind === "record.start") activate(parsed.data.sessionId);
      else deactivate(parsed.data.sessionId);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      reconnectTimer = window.setTimeout(connect, 500);
    });
    post({ kind: "content.hello", documentId, url: eventContext().url });
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("blur", onBlur, true);
  document.addEventListener("submit", onSubmit, true);
  window.setInterval(() => {
    if (!activeSessionId || location.href === lastUrl) return;
    const previous = lastUrl;
    lastUrl = location.href;
    sendEvent({
      type: "browser.navigate",
      payload: {
        ...eventContext(),
        navigationKind:
          new URL(previous).origin + new URL(previous).pathname ===
            location.origin + location.pathname &&
          new URL(previous).hash !== location.hash
            ? "fragment"
            : "history",
      },
    });
  }, 250);
  connect();
}
