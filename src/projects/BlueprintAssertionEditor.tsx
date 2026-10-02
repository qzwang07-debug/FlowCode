import { useState } from "react";
import type { AutomationBlueprintV2 } from "../../common/blueprint-v2";
import type { BlueprintEdit } from "../../common/analyzer";
export function BlueprintAssertionEditor({ assertion, steps, disabled, edit }: {
  assertion: AutomationBlueprintV2["assertions"][number]; steps: AutomationBlueprintV2["steps"];
  disabled: boolean; edit: (operation: BlueprintEdit) => void;
}) {
  const [matcher, setMatcher] = useState(assertion.matcher === "userInstruction" ? "toBeVisible" : assertion.matcher);
  const [before, setBefore] = useState(assertion.beforeStepId ?? "");
  const [after, setAfter] = useState(assertion.afterStepId ?? "");
  const [value, setValue] = useState(assertion.expected?.kind === "literal" ? JSON.stringify(assertion.expected.value) : "");
  const [valueEdited, setValueEdited] = useState(false);
  const selected = steps.find(s => s.id === (after || before));
  const save = () => {
    let expected; if (value.trim()) { try { expected = JSON.parse(value); } catch { expected = value; } }
    edit({ kind: "edit-assertion", assertionId: assertion.id,
      matcher: matcher as "toBeVisible" | "toContainText" | "toHaveText" | "toHaveURL" | "toHaveCount" | "toBeChecked",
      ...(before ? { beforeStepId: before } : {}), ...(after ? { afterStepId: after } : {}),
      ...(selected?.pageRef ? { pageRef: selected.pageRef } : {}), ...(selected?.frameRef ? { frameRef: selected.frameRef } : {}),
      ...(assertion.target ?? selected?.target ? { target: assertion.target ?? selected?.target } : {}),
      ...(expected !== undefined ? { expected: { kind: "literal", value: expected } } :
        !valueEdited && assertion.expected?.kind === "variable" ? { expected: assertion.expected } : {}) });
  };
  return <fieldset disabled={disabled} className="analyzer-assertion-edit"><legend>{assertion.id} · {assertion.confirmed ? "User confirmed" : "Proposal only"}</legend>
    <label>Matcher<select value={matcher} onChange={e => setMatcher(e.target.value)}>{["toBeVisible", "toContainText", "toHaveText", "toHaveURL", "toHaveCount", "toBeChecked"].map(m => <option key={m}>{m}</option>)}</select></label>
    <label>Before step<select value={before} onChange={e => setBefore(e.target.value)}><option value="">None</option>{steps.map(s => <option key={s.id} value={s.id}>{s.id} · {s.description}</option>)}</select></label>
    <label>After step<select value={after} onChange={e => setAfter(e.target.value)}><option value="">None</option>{steps.map(s => <option key={s.id} value={s.id}>{s.id} · {s.description}</option>)}</select></label>
    <label>Expected value (JSON or text)<textarea value={value} maxLength={4000} onChange={e => { setValue(e.target.value); setValueEdited(true); }} /></label>
    {!valueEdited && assertion.expected?.kind === "variable" && <p>Preserving typed parameter: {assertion.expected.variableRef}. Enter a fixed value to replace it.</p>}
    <div className="analyzer-actions"><button className="project-studio-quiet" disabled={!selected} onClick={save}>Save assertion proposal</button>
      {!assertion.confirmed && <button className="project-studio-quiet" onClick={() => edit({ kind: "confirm-assertion", assertionId: assertion.id })}>Confirm assertion {assertion.id}</button>}</div>
  </fieldset>;
}
