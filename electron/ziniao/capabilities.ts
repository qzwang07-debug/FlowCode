import {
  BrowserCapabilitiesSchema,
  type BrowserCapabilities,
} from "../../common/browser-environment";

export const ZINIAO_CLIENT_VERSION = "6.26.6.7";
export const ZINIAO_VALIDATED_CLIENT_VERSIONS = [
  ZINIAO_CLIENT_VERSION,
  "6.27.2.14",
] as const;
export const ZINIAO_KERNEL_VERSION = "142.0.7444.168";

/** Version-scoped accepted matrix. Unknown items stay unknown; creating a
 * local environment profile never promotes a capability by inference. */
export function validatedZiniaoCapabilities(
  checkedAt = Date.now(),
  versions: { client?: string; kernel?: string } = {},
): BrowserCapabilities {
  const client = versions.client ?? ZINIAO_CLIENT_VERSION;
  const stage5bClient = client === "6.27.2.14";
  const supported = [
    "cli-query",
    "exact-store-binding",
    "account-binding",
    "store-launch",
    "endpoint-identity",
    "semantic-capture",
    "browser.document",
    "browser.navigate",
    "browser.click",
    "browser.fill",
    "browser.select",
    "browser.check",
    "browser.submit",
    "browser.popup",
    "browser.upload",
    "browser.download",
    "iframe",
    "shadow-dom",
    "spa",
    "flush",
    "trusted-origin",
    "playwright-cdp",
    "existing-context",
    "upload",
    "download",
    ...(stage5bClient
      ? (["browser.tab-open", "cross-store-isolation"] as const)
      : (["trace"] as const)),
  ] as const;
  const unknown = [
    "kernel-preparation",
    "site-permission",
    "native-messaging",
    "browser.tab-close",
    "reconnect",
    "video",
    "login-expired",
    "pause-resume",
    "side-effect-retry",
    ...(stage5bClient
      ? (["extension-load", "trace"] as const)
      : (["browser.tab-open", "cross-store-isolation"] as const)),
  ] as const;
  const evidenceRef = stage5bClient
    ? "stage5b-ziniao-recording"
    : "stage5a-ziniao-browser";
  return BrowserCapabilitiesSchema.parse({
    schemaVersion: 1,
    id: `ziniao-1.0.8-${client}-${versions.kernel ?? ZINIAO_KERNEL_VERSION}`,
    provider: "ziniao",
    checkedAt,
    versions: {
      cli: "1.0.8",
      client,
      kernel: versions.kernel ?? ZINIAO_KERNEL_VERSION,
      playwright: "1.62.1",
    },
    transport: "cdp-adapter",
    results: [
      ...supported.map((feature) => ({
        feature,
        status: "supported" as const,
        evidenceRefs: [evidenceRef],
        detail: `Supported for the accepted ${stage5bClient ? "Stage 5B" : "Stage 5A"} version-bound evidence scope.`,
      })),
      ...(stage5bClient
        ? []
        : [
            {
              feature: "extension-load" as const,
              status: "unsupported" as const,
              evidenceRefs: ["stage5a-ziniao-browser"],
              detail:
                "Extensions.loadUnpacked was unavailable in the tested launch.",
            },
          ]),
      ...unknown.map((feature) => ({
        feature,
        status: "unknown" as const,
        evidenceRefs: [],
        detail: `Not proven for the accepted ${stage5bClient ? "Stage 5B" : "Stage 5A"} version tuple; FlowCode does not present this as supported.`,
      })),
    ],
  });
}
