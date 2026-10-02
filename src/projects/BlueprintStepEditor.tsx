import { useState } from "react";
import type { AutomationBlueprintV2, BlueprintStepV2 } from "../../common/blueprint-v2";
import type { BlueprintEdit } from "../../common/analyzer";

export function BlueprintStepEditor({ step, previous, variables, disabled, edit }: {
  step: BlueprintStepV2; previous?: BlueprintStepV2; variables: AutomationBlueprintV2["variables"];
  disabled: boolean; edit: (value: BlueprintEdit) => void;
}) {
  const [literal, setLiteral] = useState(step.input?.kind === "literal" ? JSON.stringify(step.input.value) : "");
  const choices = variables.filter(v => step.action !== "upload" || v.type === "file");
  const [variable, setVariable] = useState(step.input?.kind === "variable" ? step.input.variableRef : choices[0]?.id ?? "");
  const applyLiteral = () => { let value; try { value = JSON.parse(literal); } catch { value = literal; }
    edit({ kind: "input", stepId: step.id, input: { kind: "literal", value } }); };
  return <li className="analyzer-step">
    <div><strong>{step.description}</strong><p>{step.action} · {step.handling} · {step.pageRef ?? "unresolved page"}{step.frameRef ? ` / ${step.frameRef}` : ""}</p>
      <details><summary>Locator and evidence</summary><pre>{JSON.stringify({ target: step.target, input: step.input, evidenceRefs: step.evidenceRefs }, null, 2)}</pre></details>
    </div>
    <div className="analyzer-actions">
      <button className="project-studio-quiet" disabled={disabled} aria-label={`Mark ${step.id} manual`} onClick={() => edit({ kind: "manual", stepId: step.id, description: step.description })}>Mark manual</button>
      <button className="project-studio-quiet" disabled={disabled} aria-label={`Delete ${step.id}`} onClick={() => edit({ kind: "delete", stepId: step.id })}>Delete misoperation</button>
      {step.action === "fill" && previous?.action === "fill" && <button className="project-studio-quiet" disabled={disabled} aria-label={`Merge ${previous.id} and ${step.id}`} onClick={() => edit({ kind: "merge-inputs", stepIds: [previous.id, step.id] })}>Merge repeated input</button>}
    </div>
    {["fill", "select", "upload"].includes(step.action) && <fieldset disabled={disabled}><legend>Input binding for {step.id}</legend>
      {step.action !== "upload" && <div className="analyzer-binding-control"><label htmlFor={`fixed-${step.id}`}>Fixed value (JSON or text)</label><textarea id={`fixed-${step.id}`} value={literal} maxLength={4000} onChange={e => setLiteral(e.target.value)} /><button type="button" className="project-studio-quiet" onClick={applyLiteral}>Use fixed value</button></div>}
      <div className="analyzer-binding-control"><label htmlFor={`variable-${step.id}`}>Typed parameter</label><select id={`variable-${step.id}`} value={variable} onChange={e => setVariable(e.target.value)}><option value="">Choose parameter</option>{choices.map(v => <option key={v.id} value={v.id}>{v.name} ({v.type}) · {v.id}</option>)}</select>
        <button type="button" className="project-studio-quiet" disabled={!variable} onClick={() => edit({ kind: "input", stepId: step.id, input: { kind: "variable", variableRef: variable } })}>Use parameter</button></div>
    </fieldset>}
  </li>;
}
