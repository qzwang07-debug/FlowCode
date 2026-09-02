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

import "./project-studio.css";

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
  const [selected, setSelected] = useState<FlowProject | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await window.skillRecorder.listProjects();
    if (result.ok) {
      setProjects(result.projects ?? []);
      setError(null);
    } else {
      setError(result.error ?? "Could not read the project registry.");
    }
    setLoading(false);
  }, []);

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
        </aside>

        <section className="project-studio-content">
          {error && (
            <div className="project-studio-error" role="alert">
              {error}
            </div>
          )}
          {showCreate ? (
            <NewProjectWizard
              onCancel={() => setShowCreate(false)}
              onCreated={(project) => {
                setSelected(project);
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
      <span className="project-studio-kicker">Stage 1 · Project core</span>
      <h2>
        {projectCount === 0
          ? "Create your first automation project"
          : "Choose a project"}
      </h2>
      <p>
        FlowCode creates a versioned Playwright template, validates every file,
        and initializes a local Git repository without adding a remote.
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
  return (
    <div className="project-studio-overview">
      <span className="project-studio-kicker">
        {project.kind === "web-test" ? "Web test" : "Browser automation"}
      </span>
      <h2>{project.name}</h2>
      <p className="project-studio-path">{project.rootPath}</p>
      <dl className="project-studio-facts">
        <div>
          <dt>Template</dt>
          <dd>{project.templateId}</dd>
        </div>
        <div>
          <dt>Template version</dt>
          <dd>{project.templateVersion}</dd>
        </div>
        <div>
          <dt>Project schema</dt>
          <dd>v{project.schemaVersion}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{new Date(project.createdAt).toLocaleString()}</dd>
        </div>
      </dl>
      <div className="project-studio-boundary">
        Recording, project execution, code editing, and Agent work remain
        unavailable until their later stages.
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
