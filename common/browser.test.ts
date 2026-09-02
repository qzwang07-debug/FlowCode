import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BrowserBridgeRegistrationSchema,
  BrowserFillPayloadSchema,
  BrowserSemanticEventSchema,
  BrowserToDesktopMessageSchema,
  NativeHostManifestSchema,
} from "./browser";

const target = {
  tag: "input",
  role: "textbox",
  name: "Account",
  inputType: "text",
};
const locators = [
  { kind: "role" as const, value: "textbox|Account", unique: true, score: 100 },
];

test("browser semantic events and bridge messages round-trip strictly", () => {
  const event = BrowserSemanticEventSchema.parse({
    schemaVersion: 1,
    eventId: "event-1",
    sessionId: "session-1",
    sourceId: "chrome-profile-1",
    source: "browser",
    seq: 42,
    epochMs: 1_788_192_012_345,
    monotonicMs: 123.5,
    type: "browser.click",
    payload: {
      tabId: 17,
      frameId: 0,
      documentId: "document-1",
      url: "https://example.test/orders/new",
      target: { tag: "button", role: "button", name: "Submit" },
      locators: [
        { kind: "role", value: "button|Submit", unique: true, score: 100 },
      ],
      button: 0,
      modifiers: [],
    },
  });
  const message = BrowserToDesktopMessageSchema.parse({
    kind: "browser.event",
    protocolVersion: 1,
    event,
  });
  assert.equal(message.kind, "browser.event");
  if (message.kind !== "browser.event")
    throw new Error("Unexpected message kind.");
  assert.deepEqual(message.event, event);
  assert.throws(
    () => BrowserSemanticEventSchema.parse({ ...event, unexpected: true }),
    /unrecognized/i,
  );
  assert.doesNotThrow(() => {
    const malformed = BrowserSemanticEventSchema.safeParse({
      ...event,
      payload: { ...event.payload, url: "not a URL" },
    });
    assert.equal(malformed.success, false);
  });
});

test("password and credit-card fields cannot carry plaintext", () => {
  const base = {
    tabId: 1,
    frameId: 0,
    documentId: "document-1",
    url: "https://example.test/checkout",
    target,
    locators,
  };
  assert.throws(
    () =>
      BrowserFillPayloadSchema.parse({
        ...base,
        target: { ...target, inputType: "password" },
        value: {
          kind: "text",
          value: "do-not-save",
          length: 11,
          truncated: false,
        },
      }),
    /protected fields/i,
  );
  assert.throws(
    () =>
      BrowserFillPayloadSchema.parse({
        ...base,
        target: { ...target, autocomplete: "cc-number" },
        value: {
          kind: "text",
          value: "4111111111111111",
          length: 16,
          truncated: false,
        },
      }),
    /protected fields/i,
  );
  const protectedValue = BrowserFillPayloadSchema.parse({
    ...base,
    target: { ...target, inputType: "password" },
    value: { kind: "redacted", length: 11, reason: "password" },
  }).value;
  assert.deepEqual(protectedValue, {
    kind: "redacted",
    length: 11,
    reason: "password",
  });
  assert.equal("value" in protectedValue, false);
});

test("Chrome and Edge registrations require separate exact origins", () => {
  const registration = BrowserBridgeRegistrationSchema.parse({
    schemaVersion: 1,
    desktopExecutable: "C:\\Program Files\\FlowCode\\FlowCode.exe",
    clients: [
      {
        browser: "chrome",
        nativeHost: "com.flowcode.browser.chrome",
        origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      },
      {
        browser: "edge",
        nativeHost: "com.flowcode.browser.edge",
        origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
      },
    ],
  });
  assert.equal(registration.clients.length, 2);
  assert.throws(
    () =>
      BrowserBridgeRegistrationSchema.parse({
        ...registration,
        clients: [registration.clients[0], registration.clients[0]],
      }),
    /distinct/i,
  );
  assert.throws(
    () =>
      NativeHostManifestSchema.parse({
        name: "com.flowcode.browser.chrome",
        description: "FlowCode",
        path: "C:\\FlowCode\\host.exe",
        type: "stdio",
        allowed_origins: ["chrome-extension://*/"],
      }),
    /invalid string/i,
  );
});

test("browser status and recording lifecycle stay wired across main and preload", async () => {
  const [ipc, preload, main, controller] = await Promise.all([
    readFile("common/ipc.ts", "utf8"),
    readFile("electron/preload.cjs", "utf8"),
    readFile("electron/main.ts", "utf8"),
    readFile("electron/recorder/controller.ts", "utf8"),
  ]);
  assert.match(ipc, /browser-capture:status-changed/);
  assert.match(preload, /onBrowserCaptureStatusChanged/);
  assert.match(main, /new BrowserCaptureService/);
  assert.match(main, /browserCapture\.initialize\(\)/);
  assert.match(controller, /browserCapture\.startSession/);
  assert.match(controller, /browserCapture\.stopSession/);
});
