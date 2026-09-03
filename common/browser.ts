import { z } from "zod";

export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const MAX_BROWSER_MESSAGE_BYTES = 256 * 1024;
export const MAX_BROWSER_VALUE_LENGTH = 4096;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const TimestampSchema = z.number().int().nonnegative();
const SmallTextSchema = z.string().max(512);
const HttpUrlSchema = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Only http(s) browser URLs are accepted.");

export const BrowserKindSchema = z.enum(["chrome", "edge"]);
export type BrowserKind = z.infer<typeof BrowserKindSchema>;

export const BrowserSemanticEventTypeSchema = z.enum([
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
]);
export type BrowserSemanticEventType = z.infer<
  typeof BrowserSemanticEventTypeSchema
>;

export const BrowserLocatorSchema = z
  .object({
    kind: z.enum([
      "role",
      "label",
      "test-id",
      "id",
      "placeholder",
      "text",
      "css",
    ]),
    value: SmallTextSchema,
    unique: z.boolean(),
    score: z.number().int().min(0).max(100),
  })
  .strict();
export type BrowserLocator = z.infer<typeof BrowserLocatorSchema>;

export const BrowserTargetSummarySchema = z
  .object({
    tag: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    role: SmallTextSchema.optional(),
    name: SmallTextSchema.optional(),
    testId: SmallTextSchema.nullable().optional(),
    inputType: z.string().max(64).optional(),
    autocomplete: z.string().max(128).optional(),
  })
  .strict();
export type BrowserTargetSummary = z.infer<typeof BrowserTargetSummarySchema>;

export const BrowserCapturedValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      value: z.string().max(MAX_BROWSER_VALUE_LENGTH),
      length: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("redacted"),
      length: z.number().int().nonnegative(),
      reason: z.enum([
        "password",
        "credit-card",
        "security-code",
        "sensitive-autocomplete",
        "sensitive-field",
      ]),
    })
    .strict(),
]);
export type BrowserCapturedValue = z.infer<typeof BrowserCapturedValueSchema>;

const FrameContextFields = {
  tabId: z.number().int().nonnegative(),
  frameId: z.number().int().nonnegative(),
  documentId: IdentifierSchema,
  url: HttpUrlSchema,
};

const LocatorFields = {
  target: BrowserTargetSummarySchema,
  locators: z.array(BrowserLocatorSchema).min(1).max(12),
};

export const BrowserDocumentPayloadSchema = z
  .object({
    ...FrameContextFields,
    title: z.string().max(1024),
    referrer: HttpUrlSchema.optional(),
  })
  .strict();

export const BrowserNavigatePayloadSchema = z
  .object({
    ...FrameContextFields,
    navigationKind: z.enum([
      "document",
      "history",
      "fragment",
      "reload",
      "unknown",
    ]),
  })
  .strict();

export const BrowserClickPayloadSchema = z
  .object({
    ...FrameContextFields,
    ...LocatorFields,
    button: z.number().int().min(0).max(4),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4),
  })
  .strict();

export const BrowserFillPayloadSchema = z
  .object({
    ...FrameContextFields,
    ...LocatorFields,
    value: BrowserCapturedValueSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    const autocomplete = payload.target.autocomplete?.toLowerCase() ?? "";
    const protectedField =
      payload.target.inputType?.toLowerCase() === "password" ||
      /(^|\s)cc-(?:number|csc|exp|exp-month|exp-year)(\s|$)/.test(autocomplete);
    if (protectedField && payload.value.kind !== "redacted") {
      context.addIssue({
        code: "custom",
        message: "Protected fields cannot contain a captured value.",
        path: ["value"],
      });
    }
  });

export const BrowserSelectPayloadSchema = z
  .object({
    ...FrameContextFields,
    ...LocatorFields,
    options: z
      .array(
        z
          .object({
            value: SmallTextSchema,
            label: SmallTextSchema,
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const BrowserCheckPayloadSchema = z
  .object({
    ...FrameContextFields,
    ...LocatorFields,
    checked: z.boolean(),
  })
  .strict();

export const BrowserSubmitPayloadSchema = z
  .object({ ...FrameContextFields, ...LocatorFields })
  .strict();

export const BrowserTabOpenPayloadSchema = z
  .object({
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int(),
    openerTabId: z.number().int().nonnegative().optional(),
    url: HttpUrlSchema.optional(),
  })
  .strict();

export const BrowserTabClosePayloadSchema = z
  .object({
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int(),
    isWindowClosing: z.boolean(),
  })
  .strict();

export const BrowserPopupPayloadSchema = z
  .object({
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int(),
    openerTabId: z.number().int().nonnegative(),
    url: HttpUrlSchema.optional(),
  })
  .strict();

export const BrowserUploadPayloadSchema = z
  .object({
    ...FrameContextFields,
    ...LocatorFields,
    fileCount: z.number().int().min(1).max(1000),
    extensions: z.array(z.string().max(32)).max(50),
    mediaTypes: z.array(z.string().max(128)).max(50),
  })
  .strict();

export const BrowserDownloadPayloadSchema = z
  .object({
    downloadId: z.number().int().nonnegative(),
    tabId: z.number().int().nonnegative().nullable(),
    url: HttpUrlSchema,
    suggestedFilename: z.string().min(1).max(512).optional(),
    mime: z.string().max(128).optional(),
  })
  .strict();

const EventBaseFields = {
  schemaVersion: z.literal(1),
  eventId: IdentifierSchema,
  sessionId: IdentifierSchema,
  sourceId: IdentifierSchema,
  source: z.literal("browser"),
  seq: z.number().int().nonnegative(),
  epochMs: TimestampSchema,
  monotonicMs: z.number().nonnegative().optional(),
  privacyTags: z.array(z.string().min(1).max(64)).max(32).optional(),
};

export const BrowserSemanticEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.document"),
      payload: BrowserDocumentPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.navigate"),
      payload: BrowserNavigatePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.click"),
      payload: BrowserClickPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.fill"),
      payload: BrowserFillPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.select"),
      payload: BrowserSelectPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.check"),
      payload: BrowserCheckPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.submit"),
      payload: BrowserSubmitPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.tab-open"),
      payload: BrowserTabOpenPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.tab-close"),
      payload: BrowserTabClosePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.popup"),
      payload: BrowserPopupPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.upload"),
      payload: BrowserUploadPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...EventBaseFields,
      type: z.literal("browser.download"),
      payload: BrowserDownloadPayloadSchema,
    })
    .strict(),
]);
export type BrowserSemanticEvent = z.infer<typeof BrowserSemanticEventSchema>;

const ContentEventBaseFields = {
  documentId: IdentifierSchema,
  url: HttpUrlSchema,
};

export const BrowserContentEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("browser.document"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          title: z.string().max(1024),
          referrer: HttpUrlSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.navigate"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          navigationKind: z.enum(["history", "fragment"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.click"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          ...LocatorFields,
          button: z.number().int().min(0).max(4),
          modifiers: z
            .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
            .max(4),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.fill"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          ...LocatorFields,
          value: BrowserCapturedValueSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.select"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          ...LocatorFields,
          options: BrowserSelectPayloadSchema.shape.options,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.check"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          ...LocatorFields,
          checked: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.submit"),
      payload: z
        .object({ ...ContentEventBaseFields, ...LocatorFields })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browser.upload"),
      payload: z
        .object({
          ...ContentEventBaseFields,
          ...LocatorFields,
          fileCount: z.number().int().min(1).max(1000),
          extensions: z.array(z.string().max(32)).max(50),
          mediaTypes: z.array(z.string().max(128)).max(50),
        })
        .strict(),
    })
    .strict(),
]);
export type BrowserContentEvent = z.infer<typeof BrowserContentEventSchema>;

export const ContentToServiceWorkerMessageSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("content.hello"),
        documentId: IdentifierSchema,
        url: HttpUrlSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("content.event"),
        epochMs: TimestampSchema,
        monotonicMs: z.number().nonnegative(),
        event: BrowserContentEventSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("content.flushed"),
        sessionId: IdentifierSchema,
      })
      .strict(),
  ],
);
export type ContentToServiceWorkerMessage = z.infer<
  typeof ContentToServiceWorkerMessageSchema
>;

export const ServiceWorkerToContentMessageSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({ kind: z.literal("record.start"), sessionId: IdentifierSchema })
      .strict(),
    z
      .object({ kind: z.literal("record.stop"), sessionId: IdentifierSchema })
      .strict(),
  ],
);
export type ServiceWorkerToContentMessage = z.infer<
  typeof ServiceWorkerToContentMessageSchema
>;

export const BrowserClientCaptureStateSchema = z.enum([
  "idle",
  "recording",
  "flushing",
]);
export type BrowserClientCaptureState = z.infer<
  typeof BrowserClientCaptureStateSchema
>;

const BrowserClientStatusFields = {
  browser: BrowserKindSchema,
  sourceId: IdentifierSchema,
  extensionVersion: z.string().min(1).max(64),
  captureState: BrowserClientCaptureStateSchema,
  sessionId: IdentifierSchema.nullable(),
  lastSequence: z.number().int().min(-1),
  bufferedEvents: z.number().int().nonnegative(),
  droppedEvents: z.number().int().nonnegative(),
  grantedOriginCount: z.number().int().nonnegative(),
};

export const BrowserToDesktopMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("browser.hello"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      ...BrowserClientStatusFields,
      capabilities: z
        .array(BrowserSemanticEventTypeSchema)
        .min(1)
        .max(BrowserSemanticEventTypeSchema.options.length),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.heartbeat"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      ...BrowserClientStatusFields,
      epochMs: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("state.get"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.event"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      event: BrowserSemanticEventSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.flushed"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      browser: BrowserKindSchema,
      sourceId: IdentifierSchema,
      sessionId: IdentifierSchema,
      lastSequence: z.number().int().min(-1),
      droppedEvents: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.pong"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      nonce: IdentifierSchema,
      epochMs: TimestampSchema,
      monotonicMs: z.number().nonnegative(),
    })
    .strict(),
]);
export type BrowserToDesktopMessage = z.infer<
  typeof BrowserToDesktopMessageSchema
>;

const IdleRecordStateSchema = z
  .object({
    kind: z.literal("record.state"),
    protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
    state: z.literal("idle"),
  })
  .strict();
const ActiveRecordStateSchema = z
  .object({
    kind: z.literal("record.state"),
    protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
    state: z.literal("recording"),
    sessionId: IdentifierSchema,
    startedAtEpochMs: TimestampSchema,
  })
  .strict();

export const DesktopToBrowserMessageSchema = z.union([
  z
    .object({
      kind: z.literal("desktop.hello"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
    })
    .strict(),
  IdleRecordStateSchema,
  ActiveRecordStateSchema,
  z
    .object({
      kind: z.literal("record.start"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      sessionId: IdentifierSchema,
      startedAtEpochMs: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record.stop"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      sessionId: IdentifierSchema,
      deadlineEpochMs: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.ack"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      sessionId: IdentifierSchema,
      sourceId: IdentifierSchema,
      seq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser.ping"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      nonce: IdentifierSchema,
      epochMs: TimestampSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bridge.error"),
      protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
      code: z.enum([
        "desktop-unavailable",
        "invalid-message",
        "invalid-session",
        "protocol-mismatch",
        "unauthorized-origin",
        "write-failed",
      ]),
      message: z.string().min(1).max(512),
    })
    .strict(),
]);
export type DesktopToBrowserMessage = z.infer<
  typeof DesktopToBrowserMessageSchema
>;

export const BrowserGapSchema = z
  .object({
    schemaVersion: z.literal(1),
    gapId: IdentifierSchema,
    sessionId: IdentifierSchema,
    browser: BrowserKindSchema,
    sourceId: IdentifierSchema,
    epochMs: TimestampSchema,
    reason: z.enum([
      "flush-timeout",
      "source-disconnected",
      "buffer-overflow",
      "sequence-gap",
      "write-failed",
    ]),
    fromSequence: z.number().int().nonnegative().optional(),
    toSequence: z.number().int().nonnegative().optional(),
    droppedEvents: z.number().int().nonnegative(),
    detail: z.string().max(512).optional(),
  })
  .strict()
  .refine(
    (gap) =>
      gap.fromSequence === undefined ||
      gap.toSequence === undefined ||
      gap.toSequence >= gap.fromSequence,
    { message: "Gap sequence range is reversed." },
  );
export type BrowserGap = z.infer<typeof BrowserGapSchema>;

export const BrowserCaptureSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: IdentifierSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    eventCount: z.number().int().nonnegative(),
    gapCount: z.number().int().nonnegative(),
    degraded: z.boolean(),
    sources: z.array(
      z
        .object({
          browser: BrowserKindSchema,
          sourceId: IdentifierSchema,
          eventCount: z.number().int().nonnegative(),
          firstSequence: z.number().int().nonnegative().nullable(),
          lastSequence: z.number().int().nonnegative().nullable(),
          flushed: z.boolean(),
          droppedEvents: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine((summary) => summary.completedAt >= summary.startedAt, {
    message: "Browser capture completed before it started.",
  });
export type BrowserCaptureSummary = z.infer<typeof BrowserCaptureSummarySchema>;

export const BrowserPlatformStatusSchema = z
  .object({
    browser: BrowserKindSchema,
    hostRegistered: z.boolean(),
    connectedSources: z.number().int().nonnegative(),
    grantedOriginCount: z.number().int().nonnegative(),
    droppedEvents: z.number().int().nonnegative(),
    lastSeenAt: TimestampSchema.nullable(),
    state: BrowserClientCaptureStateSchema,
    error: z.string().max(512).nullable(),
  })
  .strict();
export type BrowserPlatformStatus = z.infer<typeof BrowserPlatformStatusSchema>;

export const BrowserCaptureStatusSchema = z
  .object({
    protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
    activeSessionId: IdentifierSchema.nullable(),
    receivedEvents: z.number().int().nonnegative(),
    gaps: z.number().int().nonnegative(),
    chrome: BrowserPlatformStatusSchema,
    edge: BrowserPlatformStatusSchema,
  })
  .strict();
export type BrowserCaptureStatus = z.infer<typeof BrowserCaptureStatusSchema>;

export const BrowserExtensionOriginSchema = z
  .string()
  .regex(/^chrome-extension:\/\/[a-p]{32}\/$/);

export const BrowserExtensionConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    browser: BrowserKindSchema,
    nativeHost: z.string().regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
    extensionId: z.string().regex(/^[a-p]{32}$/),
  })
  .strict();
export type BrowserExtensionConfig = z.infer<
  typeof BrowserExtensionConfigSchema
>;

export const BrowserBridgeRegistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    desktopExecutable: z.string().min(1).max(4096),
    clients: z
      .array(
        z
          .object({
            browser: BrowserKindSchema,
            nativeHost: z.string().regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
            origin: BrowserExtensionOriginSchema,
          })
          .strict(),
      )
      .length(2),
  })
  .strict()
  .superRefine((registration, context) => {
    for (const key of ["browser", "nativeHost", "origin"] as const) {
      if (
        new Set(registration.clients.map((client) => client[key])).size !==
        registration.clients.length
      ) {
        context.addIssue({
          code: "custom",
          message: `Registration clients must have distinct ${key} values.`,
          path: ["clients"],
        });
      }
    }
  });
export type BrowserBridgeRegistration = z.infer<
  typeof BrowserBridgeRegistrationSchema
>;

export const BrowserBridgeRuntimeSchema = z
  .object({
    schemaVersion: z.literal(1),
    endpoint: z.string().min(1).max(512),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    maxMessageBytes: z.literal(MAX_BROWSER_MESSAGE_BYTES),
  })
  .strict();
export type BrowserBridgeRuntime = z.infer<typeof BrowserBridgeRuntimeSchema>;

export const NativeBridgeConnectSchema = z
  .object({
    kind: z.literal("bridge.connect"),
    protocolVersion: z.literal(BROWSER_BRIDGE_PROTOCOL_VERSION),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    origin: BrowserExtensionOriginSchema,
  })
  .strict();
export type NativeBridgeConnect = z.infer<typeof NativeBridgeConnectSchema>;

export const NativeHostManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
    description: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    type: z.literal("stdio"),
    allowed_origins: z.array(BrowserExtensionOriginSchema).length(1),
  })
  .strict();
export type NativeHostManifest = z.infer<typeof NativeHostManifestSchema>;
