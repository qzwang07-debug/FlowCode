import { useEffect, useState, type FormEvent } from "react";
import { FREE_PROVIDER, ProviderSettingsSchema, type ProviderSettings, type ProviderCapabilities } from "../../common/analyzer";
import reviewedProvider from "../../fixtures/stage5c/reviewed-provider.json" with { type: "json" };
import "./analyzer.css";

export function ModelSettings() {
  const [settings, setSettings] = useState<ProviderSettings>(FREE_PROVIDER);
  const [saved, setSaved] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  const [runtime, setRuntime] = useState({ available: false, version: "1.18.29", detail: "Checking external runtime…" });
  const [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [migration, setMigration] = useState({ defaultAnalyzer: "copilot", migrationGate: "not-passed" });
  const load = async () => {
    try { const result = await window.skillRecorder.analyzerSettings();
      if (!result.ok) throw new Error(result.error);
      setSettings(result.value.settings); setSaved(JSON.stringify(result.value.settings));
      setCapabilities(result.value.capabilities); setKeyPresent(result.value.keyPresent); setRuntime(result.value.runtime);
      setMigration({ defaultAnalyzer: result.value.defaultAnalyzer, migrationGate: result.value.migrationGate });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load settings."); }
    finally { setBusy(null); }
  };
  useEffect(() => { void load(); }, []);
  const update = (patch: Partial<ProviderSettings>) => setSettings(s => ({ ...s, ...patch }));
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy("save"); setError(""); setNotice("");
    try { const result = await window.skillRecorder.analyzerSaveSettings({ settings,
      ...(apiKey ? { apiKey } : {}) });
      if (!result.ok) throw new Error(result.error);
      setSaved(JSON.stringify(result.value.settings)); setCapabilities(result.value.capabilities);
      setKeyPresent(result.value.keyPresent); setApiKey(""); setNotice("Settings saved locally. Model key is held only by Windows Credential Manager.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Settings could not be saved."); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy("test"); setError(""); setNotice("");
    try { const result = await window.skillRecorder.analyzerTestProvider();
      if (!result.ok) throw new Error(result.error);
      setCapabilities(result.value); setNotice(result.value.detail);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Connection test failed."); }
    finally { setBusy(null); }
  };
  const selectRuntime = async () => {
    setBusy("runtime"); setError("");
    const result = await window.skillRecorder.analyzerSelectRuntime();
    if (!result.ok) { setError(result.error); setBusy(null); } else await load();
  };
  const clearKey = async () => {
    setBusy("clear"); setError("");
    const result = await window.skillRecorder.analyzerSaveSettings({ settings, clearKey: true });
    if (!result.ok) setError(result.error); else { setKeyPresent(false); setApiKey(""); setCapabilities(null); await load(); }
    setBusy(null);
  };
  return <div className="project-studio-overview analyzer-settings" aria-busy={Boolean(busy)}>
    <h2>Model settings</h2>
    <p>OpenCode analyzes a recording using only authorized evidence. It cannot write project code. Quality gate: {migration.migrationGate}. Current default: {migration.defaultAnalyzer}. Only the reviewed configuration with current capability checks can become the OpenCode default; the legacy Copilot library remains available.</p>
    {migration.migrationGate === "passed" && <button className="project-studio-quiet" disabled={Boolean(busy)} onClick={() => {
      setSettings(ProviderSettingsSchema.parse(reviewedProvider)); setApiKey("");
      setNotice("Reviewed provider filled. Save and test before use; the stored key is never returned here. This does not start analysis or authorize new charges.");
    }}>Use quality-verified provider settings</button>}
    {error && <p className="project-studio-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section className="project-studio-panel analyzer-runtime"><h3>External OpenCode</h3>
      <p>{runtime.available ? "Ready" : "Not ready"} · Fixed version {runtime.version}</p><p>{runtime.detail}</p>
      <button className="project-studio-quiet" disabled={Boolean(busy)} onClick={() => void selectRuntime()}>Select reviewed executable</button>
    </section>
    <form onSubmit={event => void save(event)} className="project-studio-panel analyzer-settings-form">
      <h3>Provider and model</h3>
      <label>Provider ID<input value={settings.providerId} maxLength={128} required disabled={Boolean(busy)} onChange={e => update({ providerId: e.target.value })} /></label>
      <label>Base URL<input type="url" value={settings.baseUrl} maxLength={2048} required disabled={Boolean(busy)} onChange={e => update({ baseUrl: e.target.value })} /></label>
      <label>Model ID<input value={settings.modelId} maxLength={192} required disabled={Boolean(busy)} onChange={e => update({ modelId: e.target.value })} /></label>
      <label>Authentication<select value={settings.authentication} disabled={Boolean(busy)} onChange={e => update({ authentication: e.target.value as ProviderSettings["authentication"] })}>
        <option value="none">No key (free or local endpoint)</option><option value="credential-manager">Windows Credential Manager</option>
      </select></label>
      {settings.authentication === "credential-manager" && <>
        <label>New API key<input type="password" autoComplete="off" value={apiKey} maxLength={2500} disabled={Boolean(busy)} onChange={e => setApiKey(e.target.value)} /></label>
        <p>{keyPresent ? "A key is stored. The saved key is never returned to this page." : "No key stored."}</p>
        <button type="button" className="project-studio-quiet" disabled={Boolean(busy) || !keyPresent} onClick={() => void clearKey()}>Remove stored key</button>
      </>}
      <label>Pricing<select value={settings.pricing} disabled={Boolean(busy)} onChange={e => update({ pricing: e.target.value as ProviderSettings["pricing"] })}>
        <option value="free">Explicitly free</option><option value="unknown">Unknown (analysis blocked)</option><option value="metered">Metered with explicit ceiling</option>
      </select></label>
      {settings.pricing === "metered" && <>
        <label>Input USD per million tokens<input type="number" min="0" step="0.001" required value={settings.inputUsdPerMillion ?? ""} onChange={e => update({ inputUsdPerMillion: Number(e.target.value) })} /></label>
        <label>Cached input USD per million (optional)<input type="number" min="0" step="0.001" value={settings.inputCachedUsdPerMillion ?? ""} onChange={e => update({ inputCachedUsdPerMillion: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label>Output USD per million tokens<input type="number" min="0" step="0.001" required value={settings.outputUsdPerMillion ?? ""} onChange={e => update({ outputUsdPerMillion: Number(e.target.value) })} /></label>
      </>}
      <p>Free availability and provider retention policies may change. The default free endpoint is not a permanent availability guarantee. No paid fallback is automatic.</p>
      <fieldset><legend>Analysis limits</legend>
        {([ ["maxSeconds", "Time limit (seconds)", 10, 1800], ["maxTokens", "Token limit", 1024, 200000], ["maxTurns", "Maximum turns", 2, 60], ["maxCostUsd", "Cost limit (USD)", 0, 100] ] as const).map(([key, label, min, max]) =>
          <label key={key}>{label}<input type="number" required min={min} max={max} step={key === "maxCostUsd" ? "0.01" : "1"} value={settings.budget[key]} disabled={Boolean(busy)} onChange={e => update({ budget: { ...settings.budget, [key]: Number(e.target.value) } })} /></label>)}
      </fieldset>
      <div className="analyzer-actions"><button className="project-studio-primary" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : "Save model settings"}</button>
        <button type="button" className="project-studio-quiet" disabled={Boolean(busy) || saved !== JSON.stringify(settings) || Boolean(apiKey)} onClick={() => void test()}>{busy === "test" ? "Testing…" : "Test connection and tools"}</button></div>
    </form>
    <section className="project-studio-panel analyzer-capabilities"><h3>Verified model capabilities</h3>
      {capabilities ? <><dl><dt>Tool Calling</dt><dd>{capabilities.toolCalling}</dd><dt>Structured submission</dt><dd>{capabilities.structuredOutput}</dd><dt>Vision</dt><dd>{capabilities.vision}</dd></dl><p>{capabilities.detail}</p>
        {capabilities.vision !== "supported" && <p>Text-only analysis: image tools are withheld. Events and recorded Locator summaries remain available.</p>}</>
        : <p>No current capability test. Save settings, then test the connection before analyzing.</p>}
    </section>
  </div>;
}
