import { randomUUID } from "node:crypto";
import path from "node:path";
import type { z } from "zod";

import {
  BrowserEnvironmentProfileSchema,
  type BrowserEnvironmentProfile,
  ZiniaoStoreBindingSchema,
} from "../../common/browser-environment";
import {
  RecordingBrowserSelectionSchema,
  ZiniaoEnvironmentSnapshotSchema,
  ZiniaoPageSelectionRequestSchema,
  ZiniaoPrepareRequestSchema,
  ZiniaoRecordingStatusSchema,
  ZiniaoStoreSearchRequestSchema,
  type RecordingBrowserSelection,
  type ZiniaoEnvironmentSnapshot,
  type ZiniaoPageSummary,
  type ZiniaoRecordingStatus,
} from "../../common/ziniao-recording";
import {
  createZiniaoTransport,
  detectZiniaoCli,
  ZiniaoCliService,
  ZiniaoCliError,
  ziniaoConfigFingerprint,
} from "./cli-service";
import { validatedZiniaoCapabilities } from "./capabilities";
import {
  discoverZiniaoEndpoint,
  type ZiniaoEndpoint,
} from "./endpoint-discovery";
import { listZiniaoPages, type ZiniaoCdpPage } from "./cdp-client";
import { ZiniaoProfileStore } from "./profile-store";

interface PreparedPage {
  public: ZiniaoPageSummary;
  targetId: string;
}

interface Preparation {
  id: string;
  binding: z.infer<typeof ZiniaoStoreBindingSchema>;
  profileId?: string;
  endpoint: ZiniaoEndpoint;
  launchOwnership: "borrowed" | "flowcode";
  pages: PreparedPage[];
  expiresAt: number;
}

export interface ResolvedZiniaoSelection {
  selection: Extract<RecordingBrowserSelection, { provider: "ziniao" }>;
  profile: Extract<BrowserEnvironmentProfile, { provider: "ziniao" }>;
  binding: z.infer<typeof ZiniaoStoreBindingSchema>;
  endpoint: ZiniaoEndpoint;
  target: ZiniaoCdpPage;
  logicalPageId: string;
  launchOwnership: "borrowed" | "flowcode";
}

function errorMessage(error: unknown): string {
  if (error instanceof ZiniaoCliError) {
    switch (error.code) {
      case "unavailable":
        return "Ziniao CLI 1.0.8 is not installed at the detected location.";
      case "unsupported-version":
        return "The installed Ziniao CLI requires compatibility validation.";
      case "account-changed":
        return "The active Ziniao CLI account changed. Rebind the environment.";
      case "store-mismatch":
        return "The selected store identity changed or is ambiguous.";
      case "canceled":
        return "Ziniao preparation was canceled.";
      case "timed-out":
        return error.requiresStateCheck
          ? "Ziniao did not become ready before the preparation deadline. Its state was checked; prepare again after the client finishes."
          : "Ziniao did not respond before the deadline.";
      default:
        return "Ziniao returned an invalid or unsuccessful response.";
    }
  }
  return error instanceof Error ? error.message : "Ziniao preparation failed.";
}

export class ZiniaoEnvironmentService {
  private cli: ZiniaoCliService | null = null;
  private cliVersion: string | null = null;
  private readonly preparations = new Map<string, Preparation>();
  private statusValue: ZiniaoRecordingStatus = ZiniaoRecordingStatusSchema.parse({
    schemaVersion: 1,
    provider: "ziniao",
    state: "unavailable",
    cliVersion: null,
    clientVersion: null,
    kernelVersion: null,
    selectedProfileId: null,
    selectedStoreName: null,
    selectedPageTitle: null,
    eventCount: 0,
    gapCount: 0,
    error: null,
  });

  constructor(
    private readonly profiles: ZiniaoProfileStore,
    private readonly onStatus: (status: ZiniaoRecordingStatus) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly allowedClientVersions?: readonly string[],
  ) {}

  async initialize(): Promise<void> {
    try {
      const appData = process.env.APPDATA;
      const userProfile = process.env.USERPROFILE;
      if (!appData || !userProfile) throw new ZiniaoCliError("unavailable");
      const detected = await detectZiniaoCli(
        path.join(
          appData,
          "npm",
          "node_modules",
          "@ziniao-open",
          "cli",
          "bin",
          "ziniao-cli.exe",
        ),
      );
      this.cli = new ZiniaoCliService(
        createZiniaoTransport(detected.binary),
        ziniaoConfigFingerprint(
          path.join(userProfile, ".ziniao-cli", "config.json"),
        ),
      );
      this.cliVersion = detected.version;
      this.setStatus({ state: "idle", cliVersion: detected.version, error: null });
    } catch (error) {
      this.cli = null;
      this.cliVersion = null;
      this.setStatus({
        state: "unavailable",
        cliVersion: null,
        error: errorMessage(error),
      });
    }
  }

  async snapshot(): Promise<ZiniaoEnvironmentSnapshot> {
    return ZiniaoEnvironmentSnapshotSchema.parse({
      schemaVersion: 1,
      provider: "ziniao",
      available: this.cli !== null,
      profiles: await this.profiles.listPublic(),
      status: this.statusValue,
    });
  }

  status(): ZiniaoRecordingStatus {
    return this.statusValue;
  }

  async search(raw: unknown, signal?: AbortSignal) {
    const input = ZiniaoStoreSearchRequestSchema.parse(raw);
    const cli = this.requireCli();
    const result = await cli.list(
      input.page,
      input.limit,
      signal,
      input.keyword,
    );
    return {
      ok: true as const,
      page: result.page,
      limit: result.limit,
      total: result.total,
      stores: result.items,
    };
  }

  async prepare(raw: unknown, signal?: AbortSignal) {
    const request = ZiniaoPrepareRequestSchema.parse(raw);
    const cli = this.requireCli();
    this.prunePreparations();
    this.setStatus({ state: "preparing", error: null });
    try {
      let binding: z.infer<typeof ZiniaoStoreBindingSchema>;
      let existing: Extract<BrowserEnvironmentProfile, { provider: "ziniao" }> | undefined;
      if (request.kind === "profile") {
        const profile = await this.profiles.get(request.profileId);
        if (profile.provider !== "ziniao")
          throw new Error("The environment is not a Ziniao profile.");
        existing = profile;
        binding = profile.binding;
        await cli.verifyBinding(binding, signal);
      } else {
        binding = await cli.bindStore(
          request.storeId,
          request.expectedName,
          signal,
        );
      }
      const running = await cli.ensureVisibleRunning(binding, {
        signal,
        onProgress: () => this.setStatus({ state: "preparing" }),
      });
      const endpoint = await discoverZiniaoEndpoint({
        binding,
        service: cli,
        signal,
        ...(this.allowedClientVersions
          ? { allowedClientVersions: this.allowedClientVersions }
          : {}),
      });
      const rawPages = await listZiniaoPages(endpoint.webSocketDebuggerUrl, signal);
      if (rawPages.length === 0)
        throw new Error("The selected store has no recordable HTTP(S) page.");
      const pages = rawPages.map((page) => ({
        targetId: page.targetId,
        public: {
          id: `page-${randomUUID()}`,
          title: page.title || "Untitled page",
          url: page.url,
          origin: page.origin,
          frameOrigins: page.frameOrigins,
        },
      }));
      const preparation: Preparation = {
        id: `prep-${randomUUID()}`,
        binding,
        ...(existing ? { profileId: existing.id } : {}),
        endpoint,
        launchOwnership: running.launchOwnership,
        pages,
        expiresAt: this.now() + 10 * 60 * 1000,
      };
      this.preparations.set(preparation.id, preparation);
      this.setStatus({
        state: "ready",
        clientVersion: endpoint.clientVersion,
        kernelVersion: endpoint.kernelVersion,
        selectedProfileId: existing?.id ?? null,
        selectedStoreName: binding.expectedName,
        selectedPageTitle: null,
        error: null,
      });
      return {
        ok: true as const,
        preparationId: preparation.id,
        ...(existing ? { profileId: existing.id } : {}),
        storeName: binding.expectedName,
        launchOwnership: running.launchOwnership,
        pages: pages.map((page) => page.public),
        capabilityWarnings: [
          "Cold kernel preparation remains unverified for this version.",
          "Only the selected page, allowed origin, and associated popups are recorded.",
        ],
      };
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus({ state: "error", error: message });
      return { ok: false as const, error: message };
    }
  }

  async selectPage(raw: unknown) {
    const request = ZiniaoPageSelectionRequestSchema.parse(raw);
    this.prunePreparations();
    const preparation = this.preparations.get(request.preparationId);
    if (!preparation) throw new Error("The prepared Ziniao page expired. Prepare it again.");
    const page = preparation.pages.find((item) => item.public.id === request.pageId);
    if (!page) throw new Error("The selected page is outside this preparation.");
    const existing = preparation.profileId
      ? await this.profiles.get(preparation.profileId)
      : undefined;
    const now = this.now();
    const invalidFrameOrigin = request.approvedFrameOrigins.find(
      (origin) => !page.public.frameOrigins.includes(origin),
    );
    if (invalidFrameOrigin)
      throw new Error("An iframe origin is outside the prepared page scope.");
    const profile = BrowserEnvironmentProfileSchema.parse({
      schemaVersion: 1,
      id: existing?.id ?? `env-${randomUUID()}`,
      revision: (existing?.revision ?? 0) + 1,
      provider: "ziniao",
      binding: preparation.binding,
      siteScopes: [
        page.public.origin,
        ...request.approvedFrameOrigins,
      ],
      displayMode: "visible",
      loginMode: "existing-context",
      capabilities: validatedZiniaoCapabilities(now, {
        client: preparation.endpoint.clientVersion,
        kernel: preparation.endpoint.kernelVersion,
      }),
    });
    if (profile.provider !== "ziniao") throw new Error("Invalid Ziniao profile.");
    const publicProfile = await this.profiles.save(profile);
    preparation.profileId = profile.id;
    const selection = RecordingBrowserSelectionSchema.parse({
      provider: "ziniao",
      environmentProfileId: profile.id,
      preparationId: preparation.id,
      pageId: page.public.id,
      allowAssociatedPopups: request.allowAssociatedPopups,
    });
    this.setStatus({
      state: "ready",
      selectedProfileId: profile.id,
      selectedStoreName: preparation.binding.expectedName,
      selectedPageTitle: page.public.title,
      error: null,
    });
    return { ok: true as const, selection, profile: publicProfile };
  }

  async resolveSelection(
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<ResolvedZiniaoSelection> {
    const selection = RecordingBrowserSelectionSchema.parse(raw);
    if (selection.provider !== "ziniao")
      throw new Error("Expected a prepared Ziniao selection.");
    this.prunePreparations();
    const preparation = this.preparations.get(selection.preparationId);
    if (
      !preparation ||
      preparation.profileId !== selection.environmentProfileId
    )
      throw new Error("The prepared Ziniao selection expired or changed.");
    const selected = preparation.pages.find(
      (page) => page.public.id === selection.pageId,
    );
    if (!selected)
      throw new Error("The prepared Ziniao page is no longer selected.");
    const profile = await this.profiles.get(selection.environmentProfileId);
    if (profile.provider !== "ziniao")
      throw new Error("Expected a Ziniao environment profile.");
    const cli = this.requireCli();
    await cli.verifyBinding(profile.binding, signal);
    const endpoint = await discoverZiniaoEndpoint({
      binding: profile.binding,
      service: cli,
      signal,
      ...(this.allowedClientVersions
        ? { allowedClientVersions: this.allowedClientVersions }
        : {}),
    });
    const pages = await listZiniaoPages(endpoint.webSocketDebuggerUrl, signal);
    const target = pages.find((page) => page.targetId === selected.targetId);
    if (!target || !profile.siteScopes.includes(target.origin))
      throw new Error("The selected page changed or left its allowed origin.");
    // Once a recording starts, keep this opaque preparation alive for bounded
    // reconnect attempts. The capture service deletes it on terminal cleanup.
    preparation.expiresAt = this.now() + 4 * 60 * 60 * 1000;
    return {
      selection,
      profile,
      binding: profile.binding,
      endpoint,
      target,
      logicalPageId: selected.public.id,
      launchOwnership: preparation.launchOwnership,
    };
  }

  updateCaptureStatus(patch: Partial<ZiniaoRecordingStatus>): void {
    this.setStatus(patch);
  }

  releaseSelection(preparationId: string): void {
    this.preparations.delete(preparationId);
  }

  private requireCli(): ZiniaoCliService {
    if (!this.cli) throw new ZiniaoCliError("unavailable");
    return this.cli;
  }

  private prunePreparations(): void {
    const now = this.now();
    for (const [id, preparation] of this.preparations) {
      if (preparation.expiresAt <= now) this.preparations.delete(id);
    }
  }

  private setStatus(patch: Partial<ZiniaoRecordingStatus>): void {
    this.statusValue = ZiniaoRecordingStatusSchema.parse({
      ...this.statusValue,
      ...patch,
      cliVersion: patch.cliVersion ?? this.cliVersion ?? this.statusValue.cliVersion,
    });
    this.onStatus(this.statusValue);
  }
}
