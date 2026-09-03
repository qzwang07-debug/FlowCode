import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { AutomationBlueprintSchema, type BlueprintLocator } from "../../common/blueprint";
import type { BrowserLocator } from "../../common/browser";
import {
  BlueprintReviewSchema,
  EvidenceIndexSchema,
  EvidenceRecordingSummarySchema,
  EvidenceReviewSnapshotSchema,
  EvidenceReviewUpdateRequestSchema,
  FlowEventSchema,
  type EvidenceRecordingSummary,
  type EvidenceReviewSnapshot,
  type EvidenceReviewUpdateRequest,
} from "../../common/evidence";
import type { FlowProject, ProjectKind, ProjectListItem } from "../../common/project";
import { migrateSessionMeta } from "../../common/session";
import { isValidSessionId, sessionDir, sessionsRoot } from "../recorder/session-store";
import type { ProjectManager } from "../projects/project-manager";
import { scanSensitiveTexts } from "../sensitive/scanner";
import { writeBlueprintExport } from "./exporter";
import {
  BLUEPRINT_FILE,
  BLUEPRINT_REVIEW_FILE,
  EVIDENCE_INDEX_FILE,
  processEvidenceSession,
  saveBlueprintReview,
} from "./processor";

export interface EvidenceServiceOptions {
  projects: Pick<ProjectManager, "list" | "open">;
  now?: () => number;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class EvidenceService {
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: EvidenceServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async list(): Promise<EvidenceRecordingSummary[]> {
    const [names, projectItems] = await Promise.all([
      readdir(sessionsRoot()).catch((error) => {
        if (missing(error)) return [];
        throw error;
      }),
      this.options.projects.list().catch(() => [] as ProjectListItem[]),
    ]);
    const projects = new Map(
      projectItems.map((item) => [item.project.id, item.project]),
    );
    const summaries = await Promise.all(
      names
        .filter(isValidSessionId)
        .map((id) => this.summarize(id, projects).catch(() => null)),
    );
    return summaries
      .filter((summary): summary is EvidenceRecordingSummary => summary !== null)
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  get(sessionId: string): Promise<EvidenceReviewSnapshot> {
    return this.enqueue(sessionId, () => this.getUnlocked(sessionId));
  }

  update(rawInput: EvidenceReviewUpdateRequest): Promise<EvidenceReviewSnapshot> {
    const input = EvidenceReviewUpdateRequestSchema.parse(rawInput);
    return this.enqueue(input.sessionId, async () => {
      const current = await this.getUnlocked(input.sessionId);
      if (current.review.revision !== input.expectedRevision) {
        throw new Error(
          "The Blueprint review changed in another window. Reload before saving.",
        );
      }
      if (input.review.sessionId !== input.sessionId) {
        throw new Error("Blueprint review belongs to another session.");
      }
      if (
        current.session.link.projectId &&
        input.review.projectKind !== current.review.projectKind
      ) {
        throw new Error("A project-linked recording cannot change project type.");
      }
      const review = BlueprintReviewSchema.parse({
        ...this.validateReviewUpdate(current, input.review),
        revision: current.review.revision + 1,
        updatedAt: this.now(),
      });
      const authoredSensitive = await scanSensitiveTexts([
        review.intent,
        ...review.assertions.flatMap((assertion) => [
          assertion.matcher,
          assertion.expected === undefined
            ? ""
            : JSON.stringify(assertion.expected),
        ]),
      ]);
      if (authoredSensitive.values.length > 0) {
        throw new Error(
          "The review contains a sensitive value. Replace it with a named variable before saving.",
        );
      }
      await saveBlueprintReview(sessionDir(input.sessionId), review);
      return this.getUnlocked(input.sessionId);
    });
  }

  async export(
    sessionId: string,
    destination: string,
    includeScreenshots: boolean,
  ): Promise<void> {
    const snapshot = await this.get(sessionId);
    const processed = await processEvidenceSession(
      sessionDir(sessionId),
      snapshot.review.projectKind,
    );
    await writeBlueprintExport({
      destination,
      sessionDir: sessionDir(sessionId),
      blueprint: snapshot.blueprint,
      evidenceIndex: snapshot.index,
      browserEvents: processed.evidence.events
        .filter((event) => event.source === "browser" || event.source === "cdp")
        .map(({ effectiveEpochMs: _effectiveEpochMs, ...event }) =>
          FlowEventSchema.parse(event),
        ),
      includeScreenshots,
      sensitiveValues: processed.sensitiveValues,
    });
  }

  private async summarize(
    id: string,
    projects: ReadonlyMap<string, FlowProject>,
  ): Promise<EvidenceRecordingSummary | null> {
    const directory = sessionDir(id);
    if (!(await stat(directory)).isDirectory()) return null;
    const session = migrateSessionMeta(
      await readJson(path.join(directory, "session.json")),
    );
    const project = session.link.projectId
      ? projects.get(session.link.projectId)
      : undefined;
    const index = EvidenceIndexSchema.safeParse(
      await readJson(path.join(directory, EVIDENCE_INDEX_FILE)),
    );
    const review = BlueprintReviewSchema.safeParse(
      await readJson(path.join(directory, BLUEPRINT_REVIEW_FILE)),
    );
    const blueprintReady = AutomationBlueprintSchema.safeParse(
      await readJson(path.join(directory, BLUEPRINT_FILE)),
    ).success;
    return EvidenceRecordingSummarySchema.parse({
      sessionId: session.id,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      mode: session.link.mode,
      ...(session.link.projectId ? { projectId: session.link.projectId } : {}),
      ...(project ? { projectName: project.name } : {}),
      projectKind: project?.kind ?? review.data?.projectKind ?? "web-test",
      ...(session.link.targetId ? { targetId: session.link.targetId } : {}),
      desktopEventCount: index.data?.stats.desktopEvents ?? 0,
      browserEventCount: index.data?.stats.browserEvents ?? 0,
      assertionCount: review.data?.assertions.length ?? 0,
      degraded: Boolean(index.data?.gaps.length),
      blueprintReady,
    });
  }

  private async getUnlocked(sessionId: string): Promise<EvidenceReviewSnapshot> {
    const id = isValidSessionId(sessionId)
      ? sessionId
      : (() => {
          throw new Error("Invalid session id.");
        })();
    const directory = sessionDir(id);
    const session = migrateSessionMeta(
      await readJson(path.join(directory, "session.json")),
    );
    let project: FlowProject | undefined;
    if (session.link.projectId) {
      project = await this.options.projects.open(session.link.projectId).catch(() => undefined);
    }
    const storedReview = BlueprintReviewSchema.safeParse(
      await readJson(path.join(directory, BLUEPRINT_REVIEW_FILE)),
    );
    const projectKind: ProjectKind =
      project?.kind ?? storedReview.data?.projectKind ?? "web-test";
    const processed = await processEvidenceSession(directory, projectKind);
    return EvidenceReviewSnapshotSchema.parse({
      session: processed.session,
      ...(project ? { projectName: project.name } : {}),
      index: processed.index,
      review: processed.review,
      blueprint: processed.blueprint,
    });
  }

  private validateReviewUpdate(
    current: EvidenceReviewSnapshot,
    incoming: EvidenceReviewSnapshot["review"],
  ): EvidenceReviewSnapshot["review"] {
    const variables = new Map(
      incoming.variables.map((variable) => [variable.id, variable]),
    );
    if (
      variables.size !== current.review.variables.length ||
      current.review.variables.some((variable) => !variables.has(variable.id))
    ) {
      throw new Error("Blueprint variables no longer match the recording evidence.");
    }
    const reviewedVariables = current.review.variables.map((base) => {
      const edited = variables.get(base.id)!;
      const sensitive = edited.type === "secret" ? true : edited.sensitive;
      return {
        ...base,
        type: edited.type,
        sensitive,
        source: edited.type === "secret" ? ("environment" as const) : base.source,
        ...(sensitive ? { defaultValue: undefined } : {}),
      };
    });

    const assertions = new Map(
      incoming.assertions.map((assertion) => [assertion.id, assertion]),
    );
    if (
      assertions.size !== current.review.assertions.length ||
      current.review.assertions.some((assertion) => !assertions.has(assertion.id))
    ) {
      throw new Error("Blueprint assertions no longer match the recording markers.");
    }
    const screenshots = new Set(
      current.index.timeline.flatMap((item) => item.screenshotRefs),
    );
    const steps = new Map(
      current.index.timeline
        .filter((item) => item.relatedStepId)
        .map((item) => [item.relatedStepId!, item]),
    );
    const reviewedAssertions = current.review.assertions.map((base) => {
      const edited = assertions.get(base.id)!;
      if (edited.markerEventId !== base.markerEventId || edited.note !== base.note) {
        throw new Error("Assertion marker identity and text are immutable evidence.");
      }
      const step = edited.stepId ? steps.get(edited.stepId) : undefined;
      if (edited.stepId && !step) {
        throw new Error(`Unknown assertion step "${edited.stepId}".`);
      }
      if (edited.screenshotRef && !screenshots.has(edited.screenshotRef)) {
        throw new Error("Assertion screenshot is not part of this evidence index.");
      }
      if (edited.target) {
        if (!step) {
          throw new Error("A DOM target must be associated with a browser step.");
        }
        const allowed = new Set(
          [
            ...(step.target ? [step.target] : []),
            ...step.locatorCandidates.map(locatorForReview),
          ].map((locator) => JSON.stringify(locator)),
        );
        if (!allowed.has(JSON.stringify(edited.target))) {
          throw new Error("Assertion DOM target is not a recorded locator candidate.");
        }
      }
      return {
        ...base,
        ...(edited.stepId ? { stepId: edited.stepId } : { stepId: undefined }),
        ...(edited.screenshotRef
          ? { screenshotRef: edited.screenshotRef }
          : { screenshotRef: undefined }),
        ...(edited.target ? { target: edited.target } : { target: undefined }),
        matcher: edited.matcher,
        ...(edited.expected !== undefined
          ? { expected: edited.expected }
          : { expected: undefined }),
        confirmed: edited.confirmed,
      };
    });
    return {
      ...current.review,
      projectKind: incoming.projectKind,
      intent: incoming.intent,
      variables: reviewedVariables,
      assertions: reviewedAssertions,
      privacyReviewed: incoming.privacyReviewed,
    };
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(sessionId, settled);
    void settled.finally(() => {
      if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId);
    });
    return result;
  }
}

function locatorForReview(locator: BrowserLocator): BlueprintLocator {
  if (locator.kind === "role") {
    const separator = locator.value.indexOf("|");
    const role = separator >= 0 ? locator.value.slice(0, separator) : locator.value;
    const name = separator >= 0 ? locator.value.slice(separator + 1) : undefined;
    return { kind: "role", role, ...(name ? { name } : {}) };
  }
  if (locator.kind === "css") return { kind: "css", selector: locator.value };
  return { kind: locator.kind, value: locator.value };
}
