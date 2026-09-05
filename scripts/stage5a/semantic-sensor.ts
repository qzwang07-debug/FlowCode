// Isolated-world feasibility probe only. No registration in Desktop or production recording.
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

type ProbeWorld = typeof globalThis & {
  __flowcodeProbeConfig?: { binding: string; token: string };
  __flowcodeProbeControl?: (action: string) => void;
  [key: string]: unknown;
};
const world = globalThis as ProbeWorld;
const config = world.__flowcodeProbeConfig!;
if (config && !world.__flowcodeProbeControl) {
  const documentId = crypto.randomUUID();
  let active = true;
  let seq = 0;
  const pending = new Map<Element, ReturnType<typeof setTimeout>>();
  const context = () => ({
    documentId,
    url: sanitizeBrowserUrl(location.href)!,
  });
  const send = (type: string, payload: unknown) => {
    if (!active || !/^https?:$/.test(location.protocol)) return;
    (world[config.binding] as (message: string) => void)(
      JSON.stringify({
        token: config.token,
        seq: seq++,
        epochMs: Date.now(),
        monotonicMs: performance.timeOrigin + performance.now(),
        type,
        payload,
      }),
    );
  };
  const describe = (e: Element) => ({
    target: summarizeTarget(e),
    locators: buildLocatorCandidates(e),
  });
  const fill = (e: Element) => {
    clearTimeout(pending.get(e));
    pending.delete(e);
    if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement))
      return;
    send("browser.fill", {
      ...context(),
      ...describe(e),
      value: captureFieldValue(e.value, {
        inputType: e.type,
        autocomplete: e.autocomplete,
        name: e.name,
        id: e.id,
        ariaLabel: e.getAttribute("aria-label"),
        placeholder: e.getAttribute("placeholder"),
      }),
    });
  };
  const flush = () => {
    for (const e of [...pending.keys()]) fill(e);
  };
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !active) return;
      const target = targetFromEvent(e);
      if (target)
        send("browser.click", {
          ...context(),
          ...describe(target),
          button: e.button,
          modifiers: [],
        });
    },
    true,
  );
  document.addEventListener(
    "input",
    (e) => {
      if (!e.isTrusted || !active) return;
      const target = targetFromEvent(e);
      if (
        target instanceof HTMLInputElement &&
        ["checkbox", "radio", "file"].includes(target.type)
      )
        return;
      if (target) {
        clearTimeout(pending.get(target));
        pending.set(
          target,
          setTimeout(() => fill(target), 350),
        );
      }
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      if (!e.isTrusted || !active) return;
      const target = targetFromEvent(e);
      if (!target) return;
      if (target instanceof HTMLSelectElement)
        send("browser.select", {
          ...context(),
          ...describe(target),
          options: [...target.selectedOptions].map((o) => ({
            value: o.value,
            label: o.label,
          })),
        });
      else if (
        target instanceof HTMLInputElement &&
        ["checkbox", "radio"].includes(target.type)
      )
        send("browser.check", {
          ...context(),
          ...describe(target),
          checked: target.checked,
        });
      else if (
        target instanceof HTMLInputElement &&
        target.type === "file" &&
        target.files?.length
      )
        send("browser.upload", {
          ...context(),
          ...describe(target),
          ...safeUploadMetadata([...target.files]),
        });
      else fill(target);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (e) => {
      if (!e.isTrusted || !active) return;
      flush();
      const target = targetFromEvent(e);
      if (target) send("browser.submit", { ...context(), ...describe(target) });
    },
    true,
  );
  let lastUrl = location.href;
  const navigationTimer = setInterval(() => {
    if (active && lastUrl !== location.href) {
      lastUrl = location.href;
      send("browser.navigate", { ...context(), navigationKind: "history" });
    }
  }, 100);
  world.__flowcodeProbeControl = (action) => {
    if (action === "stop") {
      flush();
      send("probe.flushed", { documentId });
      active = false;
      clearInterval(navigationTimer);
    }
  };
  window.addEventListener(
    "pagehide",
    () => {
      flush();
      send("probe.flushed", { documentId });
    },
    true,
  );
  send("browser.document", { ...context(), title: document.title });
}
