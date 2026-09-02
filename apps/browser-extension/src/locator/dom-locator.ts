import type {
  BrowserLocator,
  BrowserTargetSummary,
} from "../../../../common/browser";
import { isStableDomId, rankLocatorCandidates } from "./ranking";

const TEST_ID_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-test",
] as const;
const MAX_SCAN_ELEMENTS = 3000;

function cleanText(value: string | null | undefined, max = 512): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeCss(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`);
}

export function targetFromEvent(event: Event): Element | null {
  for (const candidate of event.composedPath()) {
    if (candidate instanceof Element) return candidate;
  }
  return event.target instanceof Element ? event.target : null;
}

function implicitRole(element: Element): string | undefined {
  const explicit = cleanText(element.getAttribute("role"), 64);
  if (explicit) return explicit.split(/\s+/)[0];
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag !== "input") return undefined;
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (["button", "submit", "reset", "image"].includes(type)) return "button";
  if (type === "password") return undefined;
  if (type === "search") return "searchbox";
  if (type === "range") return "slider";
  if (type === "number") return "spinbutton";
  if (!["hidden", "file", "color"].includes(type)) return "textbox";
  return undefined;
}

function labelText(element: Element): string {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = element.labels;
    if (labels?.length) {
      return cleanText(
        [...labels]
          .map((label) => {
            const copy = label.cloneNode(true) as HTMLLabelElement;
            for (const control of copy.querySelectorAll(
              "input, select, textarea, button",
            )) {
              control.remove();
            }
            return copy.textContent;
          })
          .join(" "),
      );
    }
  }
  return "";
}

function accessibleName(element: Element): string {
  const ariaLabel = cleanText(element.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;
  const labelledBy = cleanText(element.getAttribute("aria-labelledby"));
  if (labelledBy) {
    const value = cleanText(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (value) return value;
  }
  const label = labelText(element);
  if (label) return label;
  if (element instanceof HTMLImageElement) {
    const alt = cleanText(element.alt);
    if (alt) return alt;
  }
  if (
    element instanceof HTMLInputElement &&
    ["button", "submit", "reset"].includes(element.type)
  ) {
    const value = cleanText(element.value);
    if (value) return value;
  }
  const title = cleanText(element.getAttribute("title"));
  if (title) return title;
  if (!(
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  )) {
    return cleanText(element.textContent);
  }
  return "";
}

function* deepElements(root: Document | ShadowRoot): Generator<Element> {
  let yielded = 0;
  for (const element of root.querySelectorAll("*")) {
    yield element;
    yielded += 1;
    if (yielded >= MAX_SCAN_ELEMENTS) return;
    if (element.shadowRoot) {
      for (const shadowElement of deepElements(element.shadowRoot)) {
        yield shadowElement;
        yielded += 1;
        if (yielded >= MAX_SCAN_ELEMENTS) return;
      }
    }
  }
}

function uniqueBy(predicate: (element: Element) => boolean): boolean {
  let count = 0;
  for (const candidate of deepElements(document)) {
    if (!predicate(candidate)) continue;
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

function cssSelector(element: Element): string {
  const id = cleanText(element.id, 128);
  if (id && isStableDomId(id)) return `#${escapeCss(id)}`;
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = cleanText(element.getAttribute(attribute));
    if (value) return `[${attribute}="${escapeCss(value)}"]`;
  }
  const parts: string[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < 5; depth += 1) {
    let part = current.tagName.toLowerCase();
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const siblings = [...parentElement.children].filter(
        (candidate) => candidate.tagName === current?.tagName,
      );
      if (siblings.length > 1)
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    const root = current.getRootNode();
    if (root instanceof ShadowRoot && !parentElement) current = root.host;
    else current = parentElement;
  }
  return parts.join(" > ");
}

function cssUnique(element: Element, selector: string): boolean {
  try {
    const root = element.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) {
      return root.querySelectorAll(selector).length === 1;
    }
  } catch {
    return false;
  }
  return false;
}

export function summarizeTarget(element: Element): BrowserTargetSummary {
  const role = implicitRole(element);
  const name = accessibleName(element);
  const testId = TEST_ID_ATTRIBUTES.map((attribute) =>
    cleanText(element.getAttribute(attribute)),
  ).find(Boolean);
  const summary: BrowserTargetSummary = {
    tag: element.tagName.toLowerCase(),
  };
  if (role) summary.role = role;
  if (name) summary.name = name;
  if (testId) summary.testId = testId;
  if (element instanceof HTMLInputElement) summary.inputType = element.type;
  const autocomplete = cleanText(element.getAttribute("autocomplete"), 128);
  if (autocomplete) summary.autocomplete = autocomplete;
  return summary;
}

export function buildLocatorCandidates(element: Element): BrowserLocator[] {
  const inputs: Array<{
    kind: BrowserLocator["kind"];
    value: string;
    unique: boolean;
    stable?: boolean;
  }> = [];
  const role = implicitRole(element);
  const name = accessibleName(element);
  if (role && name) {
    inputs.push({
      kind: "role",
      value: `${role}|${name}`,
      unique: uniqueBy(
        (candidate) =>
          implicitRole(candidate) === role &&
          accessibleName(candidate) === name,
      ),
    });
  }
  const label = labelText(element);
  if (label) {
    inputs.push({
      kind: "label",
      value: label,
      unique: uniqueBy((candidate) => labelText(candidate) === label),
    });
  }
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = cleanText(element.getAttribute(attribute));
    if (!value) continue;
    inputs.push({
      kind: "test-id",
      value,
      unique: uniqueBy(
        (candidate) => cleanText(candidate.getAttribute(attribute)) === value,
      ),
    });
    break;
  }
  const id = cleanText(element.id, 128);
  if (id) {
    inputs.push({
      kind: "id",
      value: id,
      unique: document.querySelectorAll(`#${escapeCss(id)}`).length === 1,
      stable: isStableDomId(id),
    });
  }
  const placeholder = cleanText(element.getAttribute("placeholder"));
  if (placeholder) {
    inputs.push({
      kind: "placeholder",
      value: placeholder,
      unique: uniqueBy(
        (candidate) =>
          cleanText(candidate.getAttribute("placeholder")) === placeholder,
      ),
    });
  }
  if (
    name &&
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
  ) {
    inputs.push({
      kind: "text",
      value: name,
      unique: uniqueBy((candidate) => accessibleName(candidate) === name),
    });
  }
  const css = cssSelector(element);
  inputs.push({ kind: "css", value: css, unique: cssUnique(element, css) });
  return rankLocatorCandidates(inputs);
}
