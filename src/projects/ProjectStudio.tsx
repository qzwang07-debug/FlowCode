import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { ProjectLocationSelection } from "../../common/ipc";
import type {
  FlowProject,
  ProjectKind,
  ProjectListItem,
} from "../../common/project";
import type { ProjectRun, ProjectRunAction } from "../../common/project-run";
import type { EvidenceRecordingSummary } from "../../common/evidence";
import type {
  ProjectFileContent,
  ProjectRunLogEvent,
  ProjectRuntimeSnapshot,
  WorktreeRecord,
} from "../../common/project-runtime";

import "./project-studio.css";
import { EvidenceReview } from "./EvidenceReview";

const PROJECT_KINDS: readonly {
  id: ProjectKind;
  title: string;
  description: string;
}[] = [
  {
    id: "web-test",
    title: "Web test",
    description:
      "Playwright Test, page objects, fixtures, assertions, and reports.",
  },
  {
    id: "browser-automation",
    title: "Browser automation",
    description:
      "A parameterized Playwright workflow with a CLI and smoke test.",
  },
];

export function ProjectStudio() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [recordings, setRecordings] = useState<EvidenceRecordingSummary[]>([]);
  const [selected, setSelected] = useState<FlowProject | null>(null);
  const [selectedRecording, setSelectedRecording] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [projectResult, recordingResult] = await Promise.all([
      window.skillRecorder.listProjects(),
      window.skillRecorder.listEvidenceRecordings(),
    ]);
    if (projectResult.ok) setProjects(projectResult.projects ?? []);
    if (recordingResult.ok) setRecordings(recordingResult.recordings);
    setError(
      !projectResult.ok
        ? projectResult.error ?? "Could not read the project registry."
        : !recordingResult.ok
          ? recordingResult.error ?? "Could not read recording evidence."
          : null,
    );
    setLoading(false);
  }, []);
  const refreshEvidence = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openProject = useCallback(async (projectId: string) => {
    setError(null);
    const result = await window.skillRecorder.openProject({ projectId });
    if (!result.ok) {
      setError(result.error ?? "Could not open the project.");
      return;
    }
    setSelected(result.project);
    setSelectedRecording(null);
    setShowCreate(false);
  }, []);

  const close = useCallback(() => {
    void window.skillRecorder.closeProjectStudio();
  }, []);

  return (
    <main className="project-studio-shell">
      <header className="project-studio-header">
        <div>
          <span className="project-studio-kicker">FlowCode</span>
          <h1>Project Studio</h1>
        </div>
        <div className="project-studio-header-actions">
          <button
            type="button"
            className="project-studio-primary"
            onClick={() => {
              setSelected(null);
              setSelectedRecording(null);
              setShowCreate(true);
              setError(null);
            }}
          >
            New project
          </button>
          <button
            type="button"
            className="project-studio-quiet"
            onClick={close}
          >
            Close
          </button>
        </div>
      </header>

      <div className="project-studio-workspace">
        <aside
          className="project-studio-sidebar"
          aria-label="FlowCode projects"
        >
          <div className="project-studio-sidebar-heading">
            <span>Projects</span>
            <span>{projects.length}</span>
          </div>
          {loading ? (
            <p className="project-studio-empty">Loading projects…</p>
          ) : projects.length === 0 ? (
            <p className="project-studio-empty">
              No projects yet. Create either template to begin.
            </p>
          ) : (
            <div className="project-studio-projects">
              {projects.map((item) => (
                <button
                  type="button"
                  className={`project-studio-project ${selected?.id === item.project.id ? "selected" : ""}`}
                  key={item.project.id}
                  disabled={item.availability !== "available"}
                  onClick={() => void openProject(item.project.id)}
                >
                  <span className="project-studio-project-name">
                    {item.project.name}
                  </span>
                  <span className="project-studio-project-meta">
                    {item.project.kind === "web-test"
                      ? "Web test"
                      : "Browser automation"}
                    {item.availability !== "available"
                      ? ` · ${item.availability}`
                      : ""}
                  </span>
                  {item.message && (
                    <span className="project-studio-project-warning">
                      {item.message}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="project-studio-sidebar-heading project-studio-recording-heading">
            <span>Recordings</span>
            <span>{recordings.length}</span>
          </div>
          {loading ? (
            <p className="project-studio-empty">Loading evidence…</p>
          ) : recordings.length === 0 ? (
            <p className="project-studio-empty">
              Record once to create a deterministic Blueprint.
            </p>
          ) : (
            <div className="project-studio-recordings">
              {recordings.map((recording) => (
                <button
                  type="button"
                  key={recording.sessionId}
                  className={selectedRecording === recording.sessionId ? "selected" : ""}
                  onClick={() => {
                    setSelected(null);
                    setShowCreate(false);
                    setSelectedRecording(recording.sessionId);
                    setError(null);
                  }}
                >
                  <span>{recording.projectName ?? "Analyze-only recording"}</span>
                  <small>
                    {new Date(recording.startedAt).toLocaleString()} · {recording.browserEventCount} browser · {recording.assertionCount} assertions
                  </small>
                  <small>{recording.degraded ? "Evidence gaps" : recording.blueprintReady ? "Blueprint ready" : "Processing"}</small>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="project-studio-content">
          {error && (
            <div className="project-studio-error" role="alert">
              {error}
            </div>
          )}
          {selectedRecording ? (
            <EvidenceReview sessionId={selectedRecording} onChanged={refreshEvidence} />
          ) : showCreate ? (
            <NewProjectWizard
              onCancel={() => setShowCreate(false)}
              onCreated={(project) => {
                setSelected(project);
                setSelectedRecording(null);
                setShowCreate(false);
                void refresh();
              }}
            />
          ) : selected ? (
            <ProjectOverview project={selected} />
          ) : (
            <Welcome
              projectCount={projects.length}
              onCreate={() => setShowCreate(true)}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function Welcome({
  projectCount,
  onCreate,
}: {
  projectCount: number;
  onCreate: () => void;
}) {
  return (
    <div className="project-studio-welcome">
      <span className="project-studio-kicker">
        Stage 4 · Projects and evidence
      </span>
      <h2>
        {projectCount === 0
          ? "Create your first automation project"
          : "Choose a project"}
      </h2>
      <p>
        FlowCode keeps projects isolated and now turns local desktop and browser
        events into a deterministic, reviewable Automation Blueprint.
      </p>
      {projectCount === 0 && (
        <button
          type="button"
          className="project-studio-primary"
          onClick={onCreate}
        >
          Create project
        </button>
      )}
    </div>
  );
}

function ProjectOverview({ project }: { project: FlowProject }) {
  const [snapshot, setSnapshot] = useState<ProjectRuntimeSnapshot | null>(null);
  const [file, setFile] = useState<ProjectFileContent | null>(null);
  const [log, setLog] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<ProjectRun | null>(null);
  const [action, setAction] = useState<ProjectRunAction>(
    project.kind === "web-test" ? "test" : "smoke",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await window.skillRecorder.projectRuntime({
      projectId: project.id,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSnapshot(result.snapshot);
    const running = result.snapshot.runs.find(
      (run) => run.status === "running" || run.status === "queued",
    );
    setActiveRun(running ?? null);
    setAction((current) =>
      result.snapshot.actions.includes(current)
        ? current
        : (result.snapshot.actions[0] ?? "typecheck"),
    );
    setError(null);
  }, [project.id]);

  useEffect(() => {
    setSnapshot(null);
    setFile(null);
    setLog("");
    setSelectedRunId(null);
    setActiveRun(null);
    void refresh();
  }, [project.id, refresh]);

  useEffect(
    () =>
      window.skillRecorder.onProjectRunLog((event: ProjectRunLogEvent) => {
        if (event.projectId !== project.id) return;
        setSelectedRunId(event.runId);
        setLog((current) => {
          const next = current + event.text;
          return next.length > 250_000
            ? `[Earlier output hidden in the UI; the bounded log remains on disk.]\n${next.slice(-250_000)}`
            : next;
        });
        if (event.run) {
          setActiveRun(null);
          void refresh();
        }
      }),
    [project.id, refresh],
  );

  const openFile = useCallback(
    async (path: string) => {
      setBusy(`file:${path}`);
      const result = await window.skillRecorder.readProjectFile({
        projectId: project.id,
        path,
      });
      if (result.ok) {
        setFile(result.file);
        setError(null);
      } else {
        setError(result.error);
      }
      setBusy(null);
    },
    [project.id],
  );

  const startRun = useCallback(async () => {
    setBusy("run");
    setLog("");
    setSelectedRunId(null);
    const result = await window.skillRecorder.startProjectRun({
      projectId: project.id,
      action,
    });
    if (result.ok) {
      setActiveRun(result.run);
      setSelectedRunId(result.run.id);
      setError(null);
    } else {
      setError(result.error);
    }
    setBusy(null);
  }, [action, project.id]);

  const cancelRun = useCallback(async () => {
    if (!activeRun) return;
    setBusy("cancel");
    const result = await window.skillRecorder.cancelProjectRun({
      projectId: project.id,
      runId: activeRun.id,
    });
    if (!result.ok) setError(result.error);
    else if (!result.canceled) setError("The run is no longer active.");
    setBusy(null);
  }, [activeRun, project.id]);

  const showRun = useCallback(
    async (run: ProjectRun) => {
      setSelectedRunId(run.id);
      setBusy(`log:${run.id}`);
      const result = await window.skillRecorder.readProjectRunLog({
        projectId: project.id,
        runId: run.id,
      });
      if (result.ok) {
        setLog(
          `${result.log.truncated ? "[Showing the latest persisted output.]\n" : ""}${result.log.content}`,
        );
        setError(null);
      } else {
        setError(result.error);
      }
      setBusy(null);
    },
    [project.id],
  );

  const createWorktree = useCallback(async () => {
    setBusy("worktree:create");
    const result = await window.skillRecorder.createProjectWorktree({
      projectId: project.id,
      reason: "Manual isolated worktree created in Project Studio",
    });
    if (!result.ok) setError(result.error);
    else {
      setError(null);
      await refresh();
    }
    setBusy(null);
  }, [project.id, refresh]);

  const updateWorktree = useCallback(
    async (
      worktree: WorktreeRecord,
      operation: "accept" | "rollback" | "cleanup",
    ) => {
      setBusy(`worktree:${worktree.id}`);
      const input = { projectId: project.id, worktreeId: worktree.id };
      const result =
        operation === "accept"
          ? await window.skillRecorder.acceptProjectWorktree(input)
          : operation === "rollback"
            ? await window.skillRecorder.rollbackProjectWorktree(input)
            : await window.skillRecorder.cleanupProjectWorktree(input);
      if (!result.ok) setError(result.error);
      else {
        setError(null);
        await refresh();
      }
      setBusy(null);
    },
    [project.id, refresh],
  );

  if (!snapshot) {
    return (
      <div className="project-studio-overview">
        <span className="project-studio-kicker">Loading project runtime</span>
        <h2>{project.name}</h2>
        <p className="project-studio-path">{project.rootPath}</p>
        {error && (
          <div className="project-studio-error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }

  const activeWorktrees = snapshot.worktrees.filter(
    (item) =>
      item.state !== "accepted" &&
      item.state !== "reverted" &&
      item.state !== "cleaned",
  );

  return (
    <div className="project-studio-runtime">
      <div className="project-studio-project-heading">
        <div>
          <span className="project-studio-kicker">
            {project.kind === "web-test" ? "Web test" : "Browser automation"}
          </span>
          <h2>{project.name}</h2>
          <p className="project-studio-path">{project.rootPath}</p>
        </div>
        <div className="project-studio-git" data-dirty={snapshot.git.dirty}>
          <span>
            {snapshot.git.dirty ? "Dirty working tree" : "Clean working tree"}
          </span>
          <code>{snapshot.git.branch ?? "detached"}</code>
          <code>{snapshot.git.headSha?.slice(0, 8) ?? "no baseline"}</code>
        </div>
      </div>

      {error && (
        <div className="project-studio-error" role="alert">
          {error}
        </div>
      )}

      <div
        className="project-studio-toolbar"
        role="toolbar"
        aria-label="Project commands"
      >
        <label>
          <span>Command</span>
          <select
            value={action}
            disabled={Boolean(activeRun)}
            onChange={(event) =>
              setAction(event.target.value as ProjectRunAction)
            }
          >
            {snapshot.actions.map((available) => (
              <option key={available} value={available}>
                npm run {available}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="project-studio-primary"
          disabled={Boolean(activeRun) || busy === "run"}
          onClick={() => void startRun()}
        >
          {busy === "run" ? "Starting…" : "Run"}
        </button>
        <button
          type="button"
          className="project-studio-quiet"
          disabled={!activeRun || busy === "cancel"}
          onClick={() => void cancelRun()}
        >
          Stop
        </button>
        <span className="project-studio-run-state">
          {activeRun ? `${activeRun.action} · running` : "Runner idle"}
        </span>
      </div>

      <div className="project-studio-code-grid">
        <section className="project-studio-panel project-studio-files">
          <div className="project-studio-panel-heading">
            <span>Files</span>
            <span>
              {snapshot.files.entries.length}
              {snapshot.files.truncated ? "+" : ""}
            </span>
          </div>
          <div className="project-studio-file-tree" role="tree">
            {snapshot.files.entries.map((entry) => {
              const depth = entry.path.split("/").length - 1;
              const name = entry.path.split("/").at(-1);
              return entry.kind === "directory" ? (
                <div
                  className="project-studio-tree-directory"
                  key={entry.path}
                  role="treeitem"
                  aria-expanded="true"
                  aria-level={depth + 1}
                  style={{ paddingLeft: 10 + depth * 14 }}
                  aria-label={entry.path}
                >
                  {name}
                </div>
              ) : (
                <button
                  type="button"
                  className={file?.path === entry.path ? "selected" : ""}
                  key={entry.path}
                  role="treeitem"
                  aria-level={depth + 1}
                  style={{ paddingLeft: 26 + depth * 14 }}
                  disabled={busy === `file:${entry.path}`}
                  title={entry.path}
                  onClick={() => void openFile(entry.path)}
                >
                  {name}
                </button>
              );
            })}
          </div>
        </section>

        <section className="project-studio-panel project-studio-viewer">
          <div className="project-studio-panel-heading">
            <span>{file?.path ?? "Read-only code viewer"}</span>
            <span>
              {file ? `${file.language} · ${file.size} B` : "Read only"}
            </span>
          </div>
          {file ? (
            <pre tabIndex={0} aria-label={`Read-only contents of ${file.path}`}>
              <code>{file.content}</code>
            </pre>
          ) : (
            <div className="project-studio-panel-empty">
              Choose a text file from the project tree. Saving remains disabled
              in Stage 2.
            </div>
          )}
        </section>
      </div>

      <div className="project-studio-bottom-grid">
        <section className="project-studio-panel project-studio-log-panel">
          <div className="project-studio-panel-heading">
            <span>Run log</span>
            <span>{selectedRunId ?? "No run selected"}</span>
          </div>
          <pre role="log" aria-live="polite" aria-label="Project run output">
            {log || "Run a template command or choose a recent run."}
          </pre>
        </section>

        <section className="project-studio-panel project-studio-history">
          <div className="project-studio-panel-heading">
            <span>Recent runs</span>
            <span>{snapshot.runs.length} runs</span>
          </div>
          <div className="project-studio-run-list">
            {snapshot.runs.length === 0 ? (
              <div className="project-studio-panel-empty">
                No project runs yet.
              </div>
            ) : (
              snapshot.runs.map((run) => (
                <button
                  type="button"
                  key={run.id}
                  className={selectedRunId === run.id ? "selected" : ""}
                  onClick={() => void showRun(run)}
                >
                  <span>{run.action ?? "command"}</span>
                  <span data-status={run.status}>{run.status}</span>
                  <time>{new Date(run.startedAt).toLocaleTimeString()}</time>
                </button>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="project-studio-panel project-studio-worktrees">
        <div className="project-studio-panel-heading">
          <span>Isolated worktrees</span>
          <button
            type="button"
            className="project-studio-quiet"
            disabled={!snapshot.git.hasCommits || busy === "worktree:create"}
            onClick={() => void createWorktree()}
          >
            {busy === "worktree:create" ? "Creating…" : "Create worktree"}
          </button>
        </div>
        {!snapshot.git.hasCommits && (
          <div className="project-studio-panel-empty">
            This Stage 1 project has no baseline commit. Commit its current
            files before creating an isolated worktree.
          </div>
        )}
        {activeWorktrees.length === 0 && snapshot.git.hasCommits ? (
          <div className="project-studio-panel-empty">
            No active isolated worktrees. Agent access is still unavailable.
          </div>
        ) : (
          <div className="project-studio-worktree-list">
            {activeWorktrees.map((worktree) => (
              <div key={worktree.id}>
                <div>
                  <strong>{worktree.branch}</strong>
                  <span>
                    {worktree.state}
                    {worktree.baseDirty ? " · base was dirty" : " · clean base"}
                  </span>
                  {worktree.lastError && <small>{worktree.lastError}</small>}
                </div>
                <div className="project-studio-worktree-actions">
                  {worktree.state === "active" && (
                    <>
                      <button
                        type="button"
                        className="project-studio-quiet"
                        disabled={busy === `worktree:${worktree.id}`}
                        onClick={() => void updateWorktree(worktree, "accept")}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="project-studio-danger"
                        disabled={busy === `worktree:${worktree.id}`}
                        onClick={() =>
                          void updateWorktree(worktree, "rollback")
                        }
                      >
                        Roll back
                      </button>
                    </>
                  )}
                  {worktree.state === "orphaned" && (
                    <button
                      type="button"
                      className="project-studio-danger"
                      disabled={busy === `worktree:${worktree.id}`}
                      onClick={() => void updateWorktree(worktree, "cleanup")}
                    >
                      Clean up
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="project-studio-boundary">
        Stage 4 boundary: files remain read-only and commands remain fixed
        template scripts. Agent access, code editing, AST assertion parsing,
        and report interpretation are not enabled.
      </div>
    </div>
  );
}

function NewProjectWizard({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (project: FlowProject) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>("web-test");
  const [location, setLocation] = useState<ProjectLocationSelection | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedName = useMemo(() => name.trim(), [name]);

  const chooseLocation = useCallback(async () => {
    if (!normalizedName) {
      setError("Enter a project name before choosing its location.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await window.skillRecorder.selectProjectLocation({
      name: normalizedName,
    });
    if (!result.ok)
      setError(result.error ?? "Could not choose a project location.");
    else if ("selection" in result) setLocation(result.selection);
    setBusy(false);
  }, [normalizedName]);

  const create = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!location) {
        setError("Choose a project location first.");
        return;
      }
      setBusy(true);
      setError(null);
      const result = await window.skillRecorder.createProject({
        name: normalizedName,
        kind,
        locationToken: location.token,
      });
      if (!result.ok) {
        setError(result.error ?? "Could not create the project.");
        setBusy(false);
        return;
      }
      onCreated(result.project);
    },
    [kind, location, normalizedName, onCreated],
  );

  return (
    <form
      className="project-studio-wizard"
      onSubmit={(event) => void create(event)}
    >
      <span className="project-studio-kicker">New project</span>
      <h2>Choose a maintained starting point</h2>

      <label className="project-studio-field">
        <span>Project name</span>
        <input
          autoFocus
          maxLength={120}
          value={name}
          placeholder="Checkout regression tests"
          onChange={(event) => {
            setName(event.target.value);
            setLocation(null);
          }}
        />
      </label>

      <fieldset className="project-studio-kind-fieldset">
        <legend>Project type</legend>
        <div className="project-studio-kind-grid">
          {PROJECT_KINDS.map((option) => (
            <label
              className={`project-studio-kind ${kind === option.id ? "selected" : ""}`}
              key={option.id}
            >
              <input
                type="radio"
                name="project-kind"
                value={option.id}
                checked={kind === option.id}
                onChange={() => setKind(option.id)}
              />
              <strong>{option.title}</strong>
              <span>{option.description}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="project-studio-location">
        <div>
          <span className="project-studio-location-label">Location</span>
          <span className="project-studio-path">
            {location?.targetPath ??
              "Choose a parent folder with the native picker."}
          </span>
        </div>
        <button
          type="button"
          className="project-studio-quiet"
          disabled={busy || !normalizedName}
          onClick={() => void chooseLocation()}
        >
          Choose folder
        </button>
      </div>

      {error && (
        <div className="project-studio-error" role="alert">
          {error}
        </div>
      )}

      <div className="project-studio-form-actions">
        <button
          type="button"
          className="project-studio-quiet"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="project-studio-primary"
          disabled={busy || !normalizedName || !location}
        >
          {busy ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}
