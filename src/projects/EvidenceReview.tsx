import { useCallback, useEffect, useMemo, useState } from "react";

import type { BlueprintLocator, JsonValue } from "../../common/blueprint";
import type { BrowserLocator } from "../../common/browser";
import type {
  BlueprintReview,
  BlueprintReviewAssertion,
  EvidenceReviewSnapshot,
} from "../../common/evidence";

const VARIABLE_TYPES: BlueprintReview["variables"][number]["type"][] = [
  "string",
  "number",
  "boolean",
  "secret",
  "file",
  "json",
];
const ASSERTION_MATCHERS = [
  "userInstruction",
  "toBeVisible",
  "toContainText",
  "toHaveText",
  "toHaveURL",
  "toHaveCount",
  "toBeChecked",
] as const;

function locatorLabel(locator: BrowserLocator): string {
  return `${locator.kind}: ${locator.value} · ${locator.unique ? "unique" : "not unique"} · ${locator.score}`;
}

function blueprintLocator(locator: BrowserLocator): BlueprintLocator {
  if (locator.kind === "role") {
    const separator = locator.value.indexOf("|");
    const role = separator >= 0 ? locator.value.slice(0, separator) : locator.value;
    const name = separator >= 0 ? locator.value.slice(separator + 1) : undefined;
    return { kind: "role", role, ...(name ? { name } : {}) };
  }
  if (locator.kind === "css") return { kind: "css", selector: locator.value };
  return { kind: locator.kind, value: locator.value };
}

function expectedText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseExpected(value: string): JsonValue | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return trimmed;
  }
}

export function EvidenceReview({
  sessionId,
  onChanged,
}: {
  sessionId: string;
  onChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<EvidenceReviewSnapshot | null>(null);
  const [review, setReview] = useState<BlueprintReview | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | "export" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [includeScreenshots, setIncludeScreenshots] = useState(false);

  const load = useCallback(async () => {
    setBusy("load");
    setError(null);
    const result = await window.skillRecorder.getEvidenceReview({ sessionId });
    if (result.ok) {
      setSnapshot(result.snapshot);
      setReview(structuredClone(result.snapshot.review));
      onChanged();
    } else {
      setError(result.error);
    }
    setBusy(null);
  }, [onChanged, sessionId]);

  useEffect(() => {
    setSnapshot(null);
    setReview(null);
    setNotice(null);
    setIncludeScreenshots(false);
    void load();
  }, [load]);

  const browserSteps = useMemo(
    () =>
      snapshot?.index.timeline.filter(
        (item) => item.kind === "browser-action" && item.relatedStepId,
      ) ?? [],
    [snapshot],
  );
  const screenshots = useMemo(
    () => [
      ...new Set(
        snapshot?.index.timeline.flatMap((item) => item.screenshotRefs) ?? [],
      ),
    ],
    [snapshot],
  );

  const updateAssertion = useCallback(
    (index: number, update: (current: BlueprintReviewAssertion) => BlueprintReviewAssertion) => {
      setReview((current) => {
        if (!current) return current;
        const assertions = [...current.assertions];
        const assertion = assertions[index];
        if (!assertion) return current;
        assertions[index] = update(assertion);
        return { ...current, assertions };
      });
    },
    [],
  );

  const chooseStep = useCallback(
    (assertionIndex: number, stepId: string) => {
      const item = browserSteps.find((candidate) => candidate.relatedStepId === stepId);
      updateAssertion(assertionIndex, (assertion) => ({
        ...assertion,
        ...(stepId ? { stepId } : { stepId: undefined }),
        ...(item?.target ? { target: item.target } : { target: undefined }),
        ...(item?.screenshotRefs[0]
          ? { screenshotRef: item.screenshotRefs[0] }
          : {}),
      }));
    },
    [browserSteps, updateAssertion],
  );

  const save = useCallback(async () => {
    if (!snapshot || !review) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    const result = await window.skillRecorder.updateEvidenceReview({
      sessionId,
      expectedRevision: snapshot.review.revision,
      review,
    });
    if (result.ok) {
      setSnapshot(result.snapshot);
      setReview(structuredClone(result.snapshot.review));
      setNotice(`Revision ${result.snapshot.review.revision} saved.`);
      onChanged();
    } else {
      setError(result.error);
    }
    setBusy(null);
  }, [onChanged, review, sessionId, snapshot]);

  const exportBlueprint = useCallback(async () => {
    if (!snapshot || !review) return;
    const warning = includeScreenshots
      ? "The export will include the screenshots explicitly attached to assertions. Continue?"
      : "Export a redacted Blueprint package without screenshots?";
    if (!window.confirm(warning)) return;
    setBusy("export");
    setError(null);
    setNotice(null);
    if (JSON.stringify(review) !== JSON.stringify(snapshot.review)) {
      const saved = await window.skillRecorder.updateEvidenceReview({
        sessionId,
        expectedRevision: snapshot.review.revision,
        review,
      });
      if (!saved.ok) {
        setError(saved.error);
        setBusy(null);
        return;
      }
      setSnapshot(saved.snapshot);
      setReview(structuredClone(saved.snapshot.review));
      onChanged();
    }
    const result = await window.skillRecorder.exportBlueprint({
      sessionId,
      includeScreenshots,
    });
    if (!result.ok) setError(result.error);
    else if ("path" in result) setNotice(`Exported to ${result.path}`);
    setBusy(null);
  }, [includeScreenshots, onChanged, review, sessionId, snapshot]);

  if (!snapshot || !review) {
    return (
      <div className="project-studio-overview">
        <span className="project-studio-kicker">Deterministic evidence</span>
        <h2>{busy === "load" ? "Building local Blueprint…" : "Recording unavailable"}</h2>
        {error && <div className="project-studio-error" role="alert">{error}</div>}
      </div>
    );
  }

  return (
    <div className="evidence-review">
      <header className="evidence-review-header">
        <div>
          <span className="project-studio-kicker">Stage 4 · Deterministic Blueprint</span>
          <h2>{snapshot.projectName ?? `Recording ${sessionId}`}</h2>
          <p>
            {new Date(snapshot.session.startedAt).toLocaleString()} · {snapshot.session.link.mode === "analyze-only" ? "Analyze only" : "Analyze and build"}
          </p>
        </div>
        <div className="evidence-review-actions">
          <button className="project-studio-quiet" disabled={Boolean(busy)} onClick={() => void load()}>
            Reload
          </button>
          <button className="project-studio-primary" disabled={Boolean(busy)} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save review"}
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div className={error ? "project-studio-error" : "evidence-review-notice"} role={error ? "alert" : "status"}>
          {error ?? notice}
        </div>
      )}

      <div className="evidence-review-stats" role="group" aria-label="Evidence summary">
        <span>{snapshot.index.stats.desktopEvents} desktop events</span>
        <span>{snapshot.index.stats.browserEvents} browser events</span>
        <span>{snapshot.index.causalLinks.length} causal links</span>
        <span>{snapshot.index.gaps.length} gaps</span>
      </div>

      <section className="project-studio-panel evidence-review-intent">
        <div className="project-studio-panel-heading">
          <span>Blueprint intent</span>
          <select
            aria-label="Project type"
            value={review.projectKind}
            disabled={Boolean(snapshot.session.link.projectId)}
            onChange={(event) =>
              setReview({
                ...review,
                projectKind: event.target.value as BlueprintReview["projectKind"],
              })
            }
          >
            <option value="web-test">Web test</option>
            <option value="browser-automation">Browser automation</option>
          </select>
        </div>
        <textarea
          aria-label="Blueprint intent"
          maxLength={2_000}
          value={review.intent}
          onChange={(event) => setReview({ ...review, intent: event.target.value })}
        />
      </section>

      <div className="evidence-review-grid">
        <section className="project-studio-panel evidence-timeline">
          <div className="project-studio-panel-heading">
            <span>Desktop steps + browser evidence</span>
            <span>{snapshot.index.timeline.length}</span>
          </div>
          <ol>
            {snapshot.index.timeline.map((item) => (
              <li key={item.id} data-kind={item.kind}>
                <time>+{((item.epochMs - snapshot.session.startedAt) / 1_000).toFixed(1)}s</time>
                <div>
                  <strong>{item.summary}</strong>
                  <small>{item.kind.replaceAll("-", " ")} · {item.type} · {item.sourceId}</small>
                  {item.locatorCandidates.length > 0 && (
                    <details>
                      <summary>{item.locatorCandidates.length} locator candidates</summary>
                      <ul>
                        {item.locatorCandidates.map((locator) => (
                          <li key={`${locator.kind}-${locator.value}`}>{locatorLabel(locator)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="project-studio-panel evidence-blueprint-steps">
          <div className="project-studio-panel-heading">
            <span>Blueprint steps</span>
            <span>{snapshot.blueprint.steps.length}</span>
          </div>
          <ol>
            {snapshot.blueprint.steps.map((step) => (
              <li key={step.id}>
                <code>{step.action}</code>
                <div>
                  <strong>{step.description}</strong>
                  {step.target && <small>{JSON.stringify(step.target)}</small>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="project-studio-panel evidence-variables">
        <div className="project-studio-panel-heading">
          <span>Variables and sensitive labels</span>
          <span>{review.variables.length}</span>
        </div>
        {review.variables.length === 0 ? (
          <div className="project-studio-panel-empty">No variable candidates were recorded.</div>
        ) : (
          <div className="evidence-variable-list">
            {review.variables.map((variable, index) => (
              <div key={variable.id}>
                <div><strong>{variable.name}</strong><code>{`{{${variable.id}}}`}</code></div>
                <select
                  aria-label={`Type for ${variable.name}`}
                  value={variable.type}
                  onChange={(event) => {
                    const variables = [...review.variables];
                    const type = event.target.value as typeof variable.type;
                    variables[index] = {
                      ...variable,
                      type,
                      sensitive: type === "secret" ? true : variable.sensitive,
                      ...(type === "secret" ? { defaultValue: undefined, source: "environment" as const } : {}),
                    };
                    setReview({ ...review, variables });
                  }}
                >
                  {VARIABLE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <label>
                  <input
                    type="checkbox"
                    checked={variable.sensitive}
                    disabled={variable.type === "secret"}
                    onChange={(event) => {
                      const variables = [...review.variables];
                      variables[index] = {
                        ...variable,
                        sensitive: event.target.checked,
                        ...(event.target.checked ? { defaultValue: undefined } : {}),
                      };
                      setReview({ ...review, variables });
                    }}
                  />
                  Sensitive
                </label>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="project-studio-panel evidence-assertions">
        <div className="project-studio-panel-heading">
          <span>Human assertion markers</span>
          <span>{review.assertions.length}</span>
        </div>
        {review.assertions.length === 0 ? (
          <div className="project-studio-panel-empty">No assertion marker was added during this recording.</div>
        ) : (
          <div className="evidence-assertion-list">
            {review.assertions.map((assertion, index) => {
              const step = browserSteps.find((item) => item.relatedStepId === assertion.stepId);
              return (
                <article key={assertion.id}>
                  <header><strong>{assertion.note}</strong><code>{assertion.id}</code></header>
                  <label>
                    <span>Related step</span>
                    <select value={assertion.stepId ?? ""} onChange={(event) => chooseStep(index, event.target.value)}>
                      <option value="">No step</option>
                      {browserSteps.map((item) => <option key={item.relatedStepId} value={item.relatedStepId}>{item.relatedStepId} · {item.summary}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Screenshot</span>
                    <select
                      value={assertion.screenshotRef ?? ""}
                      onChange={(event) => updateAssertion(index, (current) => ({ ...current, screenshotRef: event.target.value || undefined }))}
                    >
                      <option value="">No screenshot</option>
                      {screenshots.map((file) => <option key={file} value={file}>{file}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>DOM target / locator</span>
                    <select
                      value={step?.locatorCandidates.findIndex((candidate) => JSON.stringify(blueprintLocator(candidate)) === JSON.stringify(assertion.target)) ?? -1}
                      onChange={(event) => {
                        const locator = step?.locatorCandidates[Number(event.target.value)];
                        updateAssertion(index, (current) => ({ ...current, target: locator ? blueprintLocator(locator) : undefined }));
                      }}
                    >
                      <option value={-1}>No DOM target</option>
                      {step?.locatorCandidates.map((locator, locatorIndex) => <option key={`${locator.kind}-${locator.value}`} value={locatorIndex}>{locatorLabel(locator)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Matcher</span>
                    <select value={assertion.matcher} onChange={(event) => updateAssertion(index, (current) => ({ ...current, matcher: event.target.value }))}>
                      {ASSERTION_MATCHERS.map((matcher) => <option key={matcher} value={matcher}>{matcher}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Expected</span>
                    <input value={expectedText(assertion.expected)} onChange={(event) => updateAssertion(index, (current) => ({ ...current, expected: parseExpected(event.target.value) }))} />
                  </label>
                  <label className="evidence-confirm">
                    <input type="checkbox" checked={assertion.confirmed} onChange={(event) => updateAssertion(index, (current) => ({ ...current, confirmed: event.target.checked }))} />
                    Confirm as a test fact
                  </label>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="project-studio-panel evidence-export">
        <div>
          <strong>Export Automation Blueprint</strong>
          <p>Browser fill plaintext is omitted. Screenshots stay excluded unless you opt in.</p>
        </div>
        <label>
          <input type="checkbox" checked={review.privacyReviewed} onChange={(event) => setReview({ ...review, privacyReviewed: event.target.checked })} />
          Privacy labels reviewed
        </label>
        <label>
          <input type="checkbox" checked={includeScreenshots} onChange={(event) => setIncludeScreenshots(event.target.checked)} />
          Include attached screenshots
        </label>
        <button className="project-studio-primary" disabled={Boolean(busy)} onClick={() => void exportBlueprint()}>
          {busy === "export" ? "Exporting…" : "Export .zip"}
        </button>
      </section>

      <div className="project-studio-boundary">
        Stage 4 boundary: this Blueprint is deterministic and local. No model, Evidence MCP, Agent code write, AST assertion extraction, or CDP capture is enabled.
      </div>
    </div>
  );
}
