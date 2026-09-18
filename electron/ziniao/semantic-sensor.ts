import type { BrowserContentEvent } from "../../common/browser";
import {
  buildLocatorCandidates,
  summarizeTarget,
  targetFromEvent,
} from "../../apps/browser-extension/src/locator/dom-locator";
import {
  captureFieldValue,
  safeUploadMetadata,
} from "../../apps/browser-extension/src/privacy";
import { sanitizeBrowserUrl } from "../../apps/browser-extension/src/privacy/url";

type SensorPacket = {
  token: string;
  seq: number;
  epochMs: number;
  monotonicMs: number;
  type: BrowserContentEvent["type"] | "sensor.flushed";
  payload: unknown;
};
type SensorWorld = typeof globalThis & {
  __flowcodeSensorConfig?: { binding: string; token: string };
  __flowcodeSensorControl?: (action: "stop") => void;
  [key: string]: unknown;
};

const world = globalThis as SensorWorld;
const config = world.__flowcodeSensorConfig;

if (config && !world.__flowcodeSensorControl) {
  const documentId = crypto.randomUUID();
  const pendingInputs = new Map<Element, number>();
  let active = true;
  let seq = 0;
  let lastUrl = location.href;
  let lastPointerDown: { element: Element; epochMs: number } | null = null;

  const post = (packet: SensorPacket): void => {
    if (!/^https?:$/.test(location.protocol)) return;
    const binding = world[config.binding];
    if (typeof binding !== "function") return;
    (binding as (payload: string) => void)(JSON.stringify(packet));
  };
  const send = (type: SensorPacket["type"], payload: unknown): void => {
    if (!active && type !== "sensor.flushed") return;
    post({
      token: config.token,
      seq: seq++,
      epochMs: Date.now(),
      monotonicMs: performance.timeOrigin + performance.now(),
      type,
      payload,
    });
  };
  const context = () => ({
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
    )
      return element.value;
    if (element instanceof HTMLElement && element.isContentEditable)
      return element.textContent ?? "";
    return null;
  };
  const publishFill = (element: Element): void => {
    const timer = pendingInputs.get(element);
    if (timer !== undefined) clearTimeout(timer);
    pendingInputs.delete(element);
    const raw = fieldValue(element);
    if (raw === null) return;
    const target = summarizeTarget(element);
    send("browser.fill", {
      ...context(),
      target,
      locators: buildLocatorCandidates(element),
      value: captureFieldValue(raw, {
        inputType: target.inputType,
        autocomplete: target.autocomplete,
        name: element.getAttribute("name"),
        id: element.id,
        ariaLabel: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
      }),
    });
  };
  const flushInputs = (): void => {
    for (const element of [...pendingInputs.keys()]) publishFill(element);
  };
  const scheduleFill = (element: Element): void => {
    const previous = pendingInputs.get(element);
    if (previous !== undefined) clearTimeout(previous);
    pendingInputs.set(element, window.setTimeout(() => publishFill(element), 350));
  };

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!active || !event.isTrusted) return;
      const element = targetFromEvent(event);
      if (element) lastPointerDown = { element, epochMs: Date.now() };
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!active || !event.isTrusted) return;
      const target = targetFromEvent(event);
      const element =
        lastPointerDown && Date.now() - lastPointerDown.epochMs < 2000
          ? lastPointerDown.element
          : target;
      lastPointerDown = null;
      if (!element) return;
      const modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
      if (event.altKey) modifiers.push("Alt");
      if (event.ctrlKey) modifiers.push("Control");
      if (event.metaKey) modifiers.push("Meta");
      if (event.shiftKey) modifiers.push("Shift");
      send("browser.click", {
        ...context(),
        ...describe(element),
        button:
          Number.isInteger(event.button) && event.button >= 0 && event.button <= 4
            ? event.button
            : 0,
        modifiers,
      });
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (!active || !event.isTrusted) return;
      const element = targetFromEvent(event);
      if (!element) return;
      if (
        element instanceof HTMLInputElement &&
        ["checkbox", "radio", "file"].includes(element.type)
      )
        return;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLElement && element.isContentEditable)
      )
        scheduleFill(element);
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (!active || !event.isTrusted) return;
      const element = targetFromEvent(event);
      if (!element) return;
      if (
        element instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(element.type)
      ) {
        send("browser.check", {
          ...context(),
          ...describe(element),
          checked: element.checked,
        });
      } else if (
        element instanceof HTMLInputElement &&
        element.type === "file" &&
        element.files?.length
      ) {
        send("browser.upload", {
          ...context(),
          ...describe(element),
          ...safeUploadMetadata([...element.files]),
        });
      } else if (element instanceof HTMLSelectElement) {
        send("browser.select", {
          ...context(),
          ...describe(element),
          options: [...element.selectedOptions].slice(0, 50).map((option) => ({
            value: option.value.slice(0, 512),
            label: (option.label || option.textContent || "").slice(0, 512),
          })),
        });
      } else publishFill(element);
    },
    true,
  );
  document.addEventListener(
    "blur",
    (event) => {
      if (!active || !event.isTrusted) return;
      const element = targetFromEvent(event);
      if (element && pendingInputs.has(element)) publishFill(element);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (!active || !event.isTrusted) return;
      flushInputs();
      const form = targetFromEvent(event);
      if (form)
        send("browser.submit", { ...context(), ...describe(form) });
    },
    true,
  );
  const navigationTimer = window.setInterval(() => {
    if (!active || lastUrl === location.href) return;
    const previous = lastUrl;
    lastUrl = location.href;
    send("browser.navigate", {
      ...context(),
      navigationKind:
        new URL(previous).origin + new URL(previous).pathname ===
          location.origin + location.pathname &&
        new URL(previous).hash !== location.hash
          ? "fragment"
          : "history",
    });
  }, 250);
  const flush = (): void => {
    if (!active) return;
    flushInputs();
    send("sensor.flushed", { documentId });
    active = false;
    clearInterval(navigationTimer);
  };
  world.__flowcodeSensorControl = (action) => {
    if (action === "stop") flush();
  };
  window.addEventListener("pagehide", flush, true);
  send("browser.document", {
    ...context(),
    title: document.title.slice(0, 1024),
    ...(sanitizeBrowserUrl(document.referrer)
      ? { referrer: sanitizeBrowserUrl(document.referrer) ?? undefined }
      : {}),
  });
}
