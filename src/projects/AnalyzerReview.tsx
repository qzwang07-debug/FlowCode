import { useCallback, useEffect, useState } from "react";
import type { AnalyzerSnapshot, AnalyzerPreview, BlueprintEdit, AnalyzerRun, BlueprintReviewFlags } from "../../common/analyzer";
import type { BlueprintComparison } from "../../common/analyzer";
import { BlueprintStepEditor } from "./BlueprintStepEditor";
import { BlueprintAssertionEditor } from "./BlueprintAssertionEditor";
import "./analyzer.css";

export function AnalyzerReview({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<AnalyzerSnapshot | null>(null);
  const [flags, setFlags] = useState<BlueprintReviewFlags | null>(null);
  const [preview, setPreview] = useState<AnalyzerPreview | null>(null);
  const [feedback, setFeedback] = useState("");
  const [screenshots, setScreenshots] = useState(false);
  const [run, setRun] = useState<AnalyzerRun | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState("");
  const [comparison, setComparison] = useState<BlueprintComparison | null>(null);
  const [intent, setIntent] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try { const result = await window.skillRecorder.analyzerSnapshot({ sessionId });
      if (!result.ok) throw new Error(result.error);
      setSnapshot(result.value); setFlags(result.value.flags); setRun(result.value.runs[0] ?? null);
      setIntent(result.value.blueprint.intent);
    } catch (e) { setError(e instanceof Error ? e.message : "Review unavailable."); }
    finally { setBusy(null); }
  }, [sessionId]);
  useEffect(() => { setSnapshot(null); setPreview(null); setFeedback(""); setError(""); void load();
    return window.skillRecorder.onAnalyzerProgress(next => {
      if (next.sessionId !== sessionId) return; setRun(next);
      if (!["preparing", "analysis"].includes(next.phase)) { setBusy(null); void load(); }
    });
  }, [load, sessionId]);
  const active = Boolean(run && ["preparing", "analysis"].includes(run.phase));
  const disabled = Boolean(busy) || active;
  const edit = async (operation?: BlueprintEdit, decisions?: BlueprintReviewFlags) => {
    if (!snapshot) return; setBusy("save"); setError(""); setPreview(null);
    try { const result = await window.skillRecorder.analyzerEdit({ sessionId, expectedHash: snapshot.blueprint.contentHash,
      ...(operation ? { edit: operation } : {}), ...(decisions ? { flags: decisions } : {}), feedback });
      if (!result.ok) throw new Error(result.error); setSnapshot(result.value); setFlags(result.value.flags);
      setNotice(`Revision ${result.value.blueprint.revision} saved. Prior versions and raw recording are retained.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Edit could not be applied."); }
    finally { setBusy(null); }
  };
  const prepare = async () => {
    setBusy("preview"); setError("");
    try { const result = await window.skillRecorder.analyzerPreview({ sessionId, screenshots, feedback });
      if (!result.ok) throw new Error(result.error); setPreview(result.value);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not prepare protected preview."); }
    finally { setBusy(null); }
  };
  const start = async () => {
    if (!snapshot || !preview) return; setBusy("start"); setError("");
    const result = await window.skillRecorder.analyzerStart({ sessionId, previewId: preview.id, expectedHash: snapshot.blueprint.contentHash, feedback });
    setPreview(null); if (!result.ok) { setError(result.error); setBusy(null); } else { setRun(result.value); setBusy(null); }
  };
  const revoke = async () => {
    setBusy("revoke"); setPreview(null);
    const result = await window.skillRecorder.analyzerRevoke({ sessionId });
    if (!result.ok) setError(result.error); await load();
  };
  const compare = async (priorHash: string) => {
    const result = await window.skillRecorder.analyzerCompare({ sessionId, priorHash });
    if (!result.ok) setError(result.error); else setComparison(result.value);
  };
  if (!snapshot || !flags) return <section className="project-studio-panel analyzer-review"><h3>Blueprint review and preflight</h3><p role={error ? "alert" : "status"}>{error || "Loading derived review…"}</p></section>;
  const updateFlag = (patch: Partial<BlueprintReviewFlags>) => setFlags(f => f ? { ...f, ...patch } : f);
  const toggle = (key: "approvedVariableIds" | "approvedManualStepIds", id: string, checked: boolean) => updateFlag({ [key]: checked ? [...flags[key], id] : flags[key].filter(v => v !== id) });
  return <section className="analyzer-review" aria-busy={Boolean(busy)}>
    <header><h3>5C · Derived Blueprint review</h3><p>Revision {snapshot.blueprint.revision} · {snapshot.blueprint.contentHash.slice(0, 12)}. Raw recording remains unchanged. No code generation or execution is available.</p>
      <button className="project-studio-quiet" disabled={disabled} onClick={() => void load()}>Reload derived review</button></header>
    {error && <p className="project-studio-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="analyzer-review-layout">
      <section className="project-studio-panel"><h4>Reviewed steps</h4><p>{snapshot.blueprint.intent}</p>
        <ol className="analyzer-steps">{snapshot.blueprint.steps.map((step, i) => <BlueprintStepEditor key={`${snapshot.blueprint.contentHash}-${step.id}`} step={step} previous={snapshot.blueprint.steps[i - 1]} variables={snapshot.blueprint.variables} disabled={disabled} edit={value => void edit(value)} />)}</ol>
      </section>
      <section className="project-studio-panel analyzer-preflight"><h4>Generation preflight</h4><dl>
        <dt>Schema valid</dt><dd>{snapshot.preflight.schemaValid ? "Yes" : "No"}</dd><dt>Reviewable</dt><dd>{snapshot.preflight.reviewable ? "Yes" : "No"}</dd><dt>Generation conditions met</dt><dd>{snapshot.preflight.generationReady ? "Yes (Builder not implemented)" : "No"}</dd>
      </dl><ul>{snapshot.preflight.todos.map((todo, i) => <li key={`${todo.code}-${i}`} data-severity={todo.severity}><strong>{todo.severity === "blocker" ? "Required" : "Notice"}{todo.ownerId ? ` · ${todo.ownerId}` : ""}</strong><p>{todo.message}</p></li>)}</ul>
        {!snapshot.preflight.todos.length && <p>No pending review requirements for this revision.</p>}
      </section>
    </div>
    <section className="project-studio-panel analyzer-decisions"><h4>Review decisions</h4>
      <label>Derived intent<textarea maxLength={4096} disabled={disabled} value={intent} onChange={e => setIntent(e.target.value)} /></label>
      <button className="project-studio-quiet" disabled={disabled || !intent.trim() || intent === snapshot.blueprint.intent} onClick={() => void edit({ kind: "intent", intent })}>Save derived intent</button>
      <label><input type="checkbox" checked={flags.intentConfirmed} disabled={disabled} onChange={e => updateFlag({ intentConfirmed: e.target.checked })} />Intent confirmed</label>
      <label><input type="checkbox" checked={flags.privacyReviewed} disabled={disabled} onChange={e => updateFlag({ privacyReviewed: e.target.checked })} />Sensitive fields and data categories reviewed</label>
      {snapshot.blueprint.variables.filter(v => v.source !== "derived").map(v => <label key={v.id}><input type="checkbox" checked={flags.approvedVariableIds.includes(v.id)} disabled={disabled} onChange={e => toggle("approvedVariableIds", v.id, e.target.checked)} />Reviewed parameter: {v.name} ({v.type})</label>)}
      {snapshot.blueprint.steps.filter(s => s.handling === "manual").map(s => <label key={s.id}><input type="checkbox" checked={flags.approvedManualStepIds.includes(s.id)} disabled={disabled} onChange={e => toggle("approvedManualStepIds", s.id, e.target.checked)} />Reviewed manual handoff: {s.id}</label>)}
      {snapshot.blueprint.assertions.map(a => <BlueprintAssertionEditor key={`${snapshot.blueprint.contentHash}-${a.id}`} assertion={a} steps={snapshot.blueprint.steps} disabled={disabled} edit={operation => void edit(operation)} />)}
      <button className="project-studio-quiet" disabled={disabled} onClick={() => void edit(undefined, flags)}>Save version-bound review decisions</button>
    </section>
    <section className="project-studio-panel analyzer-analysis"><h4>Read-only analysis</h4>
      <label>Human feedback for the next revision<textarea maxLength={8000} value={feedback} disabled={disabled} onChange={e => { setFeedback(e.target.value); setPreview(null); }} /></label>
      <label><input type="checkbox" checked={screenshots} disabled={disabled} onChange={e => { setScreenshots(e.target.checked); setPreview(null); }} />Request protected images if Vision and local OCR are verified</label>
      <div className="analyzer-actions"><button className="project-studio-primary" disabled={disabled} onClick={() => void prepare()}>Preview model data</button>
        <button className="project-studio-quiet" disabled={Boolean(busy)} onClick={() => void revoke()}>Revoke evidence access{active ? " and stop" : ""}</button></div>
      {preview && <div className="analyzer-preview"><h5>Data to authorize</h5><ul>{preview.categories.map(c => <li key={c}>{c}</li>)}</ul><p>{preview.redactionCount} sensitive value(s) protected. {preview.visionDegraded ? "Vision or local OCR is unavailable: image tools withheld." : "Image capability verified."}</p><pre>{preview.sample || "No timeline text. Only the listed Blueprint data is available."}</pre>
        <button className="project-studio-primary" disabled={disabled} onClick={() => void start()}>Authorize read-only analysis</button></div>}
      {run && <p role="status">{run.phase} · {run.model}{run.elapsedMs !== undefined ? ` · ${(run.elapsedMs / 1000).toFixed(1)}s` : ""}{run.costUsd !== undefined ? ` · USD ${run.costUsd}` : " · cost unavailable"}{run.error ? ` · ${run.error}` : ""}</p>}
    </section>
    <details className="project-studio-panel analyzer-history"><summary>Revision history and changed steps ({snapshot.history.length})</summary><ol>{snapshot.history.map(h => <li key={h.contentHash}><strong>Revision {h.revision} · {h.author}</strong><p>{h.changedStepIds.length ? `Changed: ${h.changedStepIds.join(", ")}` : "No step content changes"}</p>{h.feedback && <p>Feedback: {h.feedback}</p>}
      <button className="project-studio-quiet" disabled={disabled} onClick={() => void compare(h.contentHash)}>Compare revision {h.revision} with current</button></li>)}</ol>
      {comparison && <div><h4>Revision {comparison.beforeRevision} → {comparison.afterRevision}</h4>{comparison.differences.length ? comparison.differences.map(d => <div key={d.field}><h5>{d.field}</h5><div className="analyzer-diff"><div><strong>Before</strong><pre>{d.before}</pre></div><div><strong>After</strong><pre>{d.after}</pre></div></div></div>) : <p>No content changes.</p>}</div>}
    </details>
  </section>;
}
