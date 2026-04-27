import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchInferWorkflow,
  fetchLogs,
  fetchRepos,
  fetchRun,
  fetchWorkflows,
  removeRepo,
  triggerRun,
  type Repo,
  type RunState,
  type RunStatus,
  type WorkflowSummary,
} from "./api";
import AddRepoModal from "./AddRepoModal";

const GENERIC_UI_WORKFLOWS = new Set(["dev", "ask"]);

function extractFreshreleaseTaskUrl(text: string): string | undefined {
  const m = text.match(
    /https?:\/\/[^\s]+freshrelease\.com\/ws\/[^/\s]+\/tasks\/[^\s)]+/i
  );
  return m?.[0];
}

const STATUS_COLORS: Record<RunStatus, string> = {
  queued: "var(--warning)",
  running: "var(--accent)",
  success: "var(--success)",
  failed: "var(--error)",
};

const SELECTED_REPO_KEY = "archon-hub:selected-repo";
const SELECTED_WORKFLOW_KEY = "archon-hub:selected-workflow";

// Input ids that should render as multi-line textareas rather than single-line inputs.
const LONG_INPUT_IDS = new Set([
  "requirement",
  "bug",
  "question",
  "description",
  "prompt",
  "hint",
  "notes",
  "context",
  "focus",
]);

function StatusChip({ status }: { status: RunStatus }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 9999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: STATUS_COLORS[status],
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {status}
    </span>
  );
}

export default function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(
    () => localStorage.getItem(SELECTED_REPO_KEY)
  );
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [logs, setLogs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [branchOverride, setBranchOverride] = useState("");
  const logOffset = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load repos.
  const refreshRepos = useCallback(async () => {
    try {
      const list = await fetchRepos();
      setRepos(list);
      setSelectedRepoId((prev) => {
        if (prev && list.some((r) => r.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch {
      setError("Failed to load repos. Is archon-hub-server running?");
    }
  }, []);

  useEffect(() => {
    refreshRepos();
  }, [refreshRepos]);

  // Persist repo selection.
  useEffect(() => {
    if (selectedRepoId) localStorage.setItem(SELECTED_REPO_KEY, selectedRepoId);
  }, [selectedRepoId]);

  // Load workflows for selected repo.
  useEffect(() => {
    if (!selectedRepoId) {
      setWorkflows([]);
      setSelectedWorkflow(null);
      return;
    }
    setError(null);
    fetchWorkflows(selectedRepoId)
      .then((wfs) => {
        setWorkflows(wfs);
        const stored = localStorage.getItem(
          `${SELECTED_WORKFLOW_KEY}:${selectedRepoId}`
        );
        const initial =
          stored && wfs.some((w) => w.name === stored)
            ? stored
            : wfs[0]?.name ?? null;
        setSelectedWorkflow(initial);
      })
      .catch((err) => {
        setWorkflows([]);
        setSelectedWorkflow(null);
        setError(
          `Failed to load workflows for this repo: ${err.message ?? "unknown error"}`
        );
      });
  }, [selectedRepoId]);

  useEffect(() => {
    if (selectedRepoId && selectedWorkflow) {
      localStorage.setItem(
        `${SELECTED_WORKFLOW_KEY}:${selectedRepoId}`,
        selectedWorkflow
      );
    }
  }, [selectedRepoId, selectedWorkflow]);

  useEffect(() => {
    setInputValues({});
  }, [selectedWorkflow]);

  const selectedWorkflowMeta = workflows.find((w) => w.name === selectedWorkflow) ?? null;
  const declaredInputs = selectedWorkflowMeta?.inputs ?? [];
  const missingRequired = declaredInputs
    .filter((i) => i.required)
    .some((i) => !(inputValues[i.id] ?? "").trim());
  const hasAnyInputValue = declaredInputs.some(
    (i) => (inputValues[i.id] ?? "").trim().length > 0
  );
  const canRun =
    !!selectedRepoId &&
    !!selectedWorkflow &&
    !submitting &&
    (declaredInputs.length === 0 ? false : !missingRequired && hasAnyInputValue);

  const handleRun = useCallback(async () => {
    if (!selectedRepoId || !selectedWorkflow) return;
    if (declaredInputs.length > 0 && missingRequired) return;

    const trimmedInputs: Record<string, string> = {};
    for (const def of declaredInputs) {
      const val = (inputValues[def.id] ?? "").trim();
      if (val) trimmedInputs[def.id] = val;
    }
    const primary =
      trimmedInputs.requirement ??
      trimmedInputs.bug ??
      trimmedInputs.question ??
      Object.values(trimmedInputs)[0] ??
      "";

    setSubmitting(true);
    setError(null);
    setLogs("");
    setRun(null);
    logOffset.current = 0;
    try {
      let workflowToRun = selectedWorkflow;
      if (GENERIC_UI_WORKFLOWS.has(selectedWorkflow) && primary.trim()) {
        try {
          const { keywordMatch } = await fetchInferWorkflow(selectedRepoId, primary);
          if (
            keywordMatch &&
            workflows.some((w) => w.name === keywordMatch)
          ) {
            workflowToRun = keywordMatch;
          }
        } catch {
          // keep sidebar selection
        }
      }

      if (
        (workflowToRun === "fr-analyze" || workflowToRun === "fr-task-finisher") &&
        !trimmedInputs.frUrl
      ) {
        const frUrl = extractFreshreleaseTaskUrl(primary);
        if (frUrl) trimmedInputs.frUrl = frUrl;
      }

      const runMeta = workflows.find((w) => w.name === workflowToRun);
      if (!runMeta) {
        setError(`Workflow "${workflowToRun}" is not available for this repo.`);
        return;
      }
      const runMissing = runMeta.inputs
        .filter((i) => i.required)
        .filter((i) => !(trimmedInputs[i.id] ?? "").trim());
      if (runMissing.length > 0) {
        setError(
          `Workflow "${workflowToRun}" requires: ${runMissing.map((i) => i.label || i.id).join(", ")}`
        );
        return;
      }

      const id = await triggerRun(
        selectedRepoId,
        workflowToRun,
        primary,
        trimmedInputs,
        branchOverride.trim() || undefined
      );
      setRunId(id);
    } catch (err: any) {
      setError(`Failed to start workflow run: ${err.message ?? "unknown error"}`);
    } finally {
      setSubmitting(false);
    }
  }, [
    selectedRepoId,
    selectedWorkflow,
    declaredInputs,
    missingRequired,
    inputValues,
    workflows,
  ]);

  useEffect(() => {
    if (!runId || !selectedRepoId) return;
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        try {
          const [runState, logData] = await Promise.all([
            fetchRun(selectedRepoId, runId),
            fetchLogs(selectedRepoId, runId, logOffset.current),
          ]);
          if (cancelled) break;

          setRun(runState);
          if (logData.content) {
            setLogs((prev) => prev + logData.content);
            logOffset.current = logData.nextOffset;
          }
          if (runState.status === "success" || runState.status === "failed") {
            break;
          }
        } catch {
          // server may be busy
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [runId, selectedRepoId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleRemoveRepo = useCallback(
    async (id: string) => {
      if (!confirm("Remove this repo from Archon Hub?")) {
        return;
      }
      try {
        await removeRepo(id);
        await refreshRepos();
      } catch (err: any) {
        setError(`Failed to remove repo: ${err.message ?? "unknown error"}`);
      }
    },
    [refreshRepos]
  );

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* Sidebar */}
      <aside
        style={{
          width: 300,
          borderRight: "1px solid var(--border)",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
        <div style={{ padding: "20px 16px", borderBottom: "1px solid var(--border)" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Archon Hub
          </h1>
          <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
            Multi-repo workflow runner
          </p>
        </div>

        {/* Repos section */}
        <div
          style={{
            padding: "12px 16px 8px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-dim)",
            }}
          >
            Repos
          </span>
          <button
            onClick={() => setShowAddRepo(true)}
            style={{
              padding: "2px 8px",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + Import
          </button>
        </div>

        <div style={{ padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
          {repos.map((repo) => {
            const active = repo.id === selectedRepoId;
            return (
              <div
                key={repo.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  borderRadius: 6,
                  background: active ? "var(--surface-hover)" : "transparent",
                }}
              >
                <button
                  onClick={() => setSelectedRepoId(repo.id)}
                  style={{
                    flex: 1,
                    padding: "8px 10px",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: active ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer",
                    overflow: "hidden",
                  }}
                  title={repo.origin}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {repo.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {repo.defaultBranch}
                  </div>
                </button>
                <button
                  onClick={() => handleRemoveRepo(repo.id)}
                  title="Remove repo"
                  style={{
                    padding: "4px 8px",
                    background: "transparent",
                    color: "var(--text-dim)",
                    border: "none",
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          {repos.length === 0 && (
            <p style={{ padding: "12px 10px", fontSize: 12, color: "var(--text-dim)" }}>
              No repos yet. Click <strong>+ Import</strong> to add one.
            </p>
          )}
        </div>

        {/* Workflows section */}
        <div
          style={{
            padding: "12px 16px 8px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--text-dim)",
            }}
          >
            Workflows
          </span>
        </div>

        <nav style={{ flex: 1, overflowY: "auto", padding: "0 0 8px" }}>
          {workflows.map((w) => (
            <button
              key={w.name}
              onClick={() => setSelectedWorkflow(w.name)}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 16px",
                border: "none",
                background:
                  selectedWorkflow === w.name ? "var(--surface-hover)" : "transparent",
                color: selectedWorkflow === w.name ? "var(--text)" : "var(--text-dim)",
                textAlign: "left",
                cursor: "pointer",
                borderLeft:
                  selectedWorkflow === w.name
                    ? "3px solid var(--accent)"
                    : "3px solid transparent",
                transition: "all 0.15s",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{w.name}</div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-dim)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {w.description}
              </div>
            </button>
          ))}
          {selectedRepoId && workflows.length === 0 && (
            <p style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-dim)" }}>
              No workflows in this repo. Add YAML files to <br />
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                .archon/workflows/
              </code>{" "}
              in the repo&apos;s default branch.
            </p>
          )}
        </nav>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>
              {selectedRepo?.name ?? "No repo selected"}
              {selectedWorkflowMeta && (
                <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
                  {" "}
                  · {selectedWorkflowMeta.name}
                </span>
              )}
            </h2>
            {selectedWorkflowMeta && (
              <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2 }}>
                {selectedWorkflowMeta.steps.length} steps:{" "}
                {selectedWorkflowMeta.steps.map((s) => s.id).join(" → ")}
              </p>
            )}
          </div>
          {run && <StatusChip status={run.status} />}
        </header>

        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          {declaredInputs.length === 0 ? (
            <p style={{ color: "var(--text-dim)", fontSize: 13, margin: 0 }}>
              {selectedWorkflow
                ? "This workflow takes no inputs. Click Run Workflow to start."
                : "Select a workflow to configure inputs."}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {declaredInputs.map((inp) => {
                const isLong = LONG_INPUT_IDS.has(inp.id);
                const value = inputValues[inp.id] ?? "";
                const onChange = (v: string) =>
                  setInputValues((prev) => ({ ...prev, [inp.id]: v }));
                const common = {
                  value,
                  onChange: (
                    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
                  ) => onChange(e.target.value),
                  placeholder: inp.required
                    ? `${inp.label} (required)`
                    : `${inp.label} (optional)`,
                  style: {
                    width: "100%",
                    padding: "10px 12px",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--text)",
                    fontSize: 14,
                    fontFamily: "inherit",
                    outline: "none",
                    boxSizing: "border-box" as const,
                  },
                  onFocus: (
                    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
                  ) => (e.currentTarget.style.borderColor = "var(--accent)"),
                  onBlur: (
                    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>
                  ) => (e.currentTarget.style.borderColor = "var(--border)"),
                };
                return (
                  <label
                    key={inp.id}
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-dim)",
                        fontWeight: 600,
                        letterSpacing: "0.02em",
                      }}
                    >
                      {inp.label}
                      {inp.required && (
                        <span style={{ color: "var(--error)" }}> *</span>
                      )}
                      <span
                        style={{
                          marginLeft: 6,
                          fontWeight: 400,
                          color: "var(--text-dim)",
                        }}
                      >
                        ({inp.id})
                      </span>
                    </span>
                    {isLong ? (
                      <textarea {...common} rows={3} style={{ ...common.style, resize: "vertical" }} />
                    ) : (
                      <input {...common} type="text" />
                    )}
                  </label>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-dim)",
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                }}
              >
                Branch
                <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--text-dim)" }}>
                  (defaults to {selectedRepo?.defaultBranch ?? "default"})
                </span>
              </span>
              <input
                type="text"
                value={branchOverride}
                onChange={(e) => setBranchOverride(e.target.value)}
                placeholder={selectedRepo?.defaultBranch ?? "main"}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 14,
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </label>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
            }}
          >
            {error ? (
              <p style={{ color: "var(--error)", fontSize: 13 }}>{error}</p>
            ) : (
              <span />
            )}
            <button
              onClick={handleRun}
              disabled={!canRun}
              style={{
                padding: "8px 24px",
                background: !canRun ? "var(--border)" : "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                cursor: !canRun ? "not-allowed" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {submitting ? "Starting..." : "Run Workflow"}
            </button>
          </div>
        </div>

        {run && (
          <div
            style={{
              padding: "12px 24px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
              overflowX: "auto",
              flexShrink: 0,
            }}
          >
            {run.steps.map((step, i) => (
              <div
                key={step.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: step.status === "queued" ? "var(--text-dim)" : "var(--text)",
                }}
              >
                {i > 0 && <span style={{ color: "var(--text-dim)" }}>→</span>}
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATUS_COLORS[step.status],
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontWeight: step.status === "running" ? 600 : 400 }}>
                  {step.id}
                </span>
              </div>
            ))}
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "16px 24px",
            background: "var(--bg)",
          }}
        >
          {logs ? (
            <pre
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--text-dim)",
              }}
            >
              {logs}
              <div ref={logEndRef} />
            </pre>
          ) : (
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 13,
                textAlign: "center",
                marginTop: 80,
              }}
            >
              {runId
                ? "Waiting for logs..."
                : selectedRepoId
                  ? "Select a workflow, fill in its inputs, and click Run."
                  : "Import a repo to get started."}
            </p>
          )}
        </div>
      </main>

      {showAddRepo && (
        <AddRepoModal
          onClose={() => setShowAddRepo(false)}
          onAdded={(repo) => {
            setRepos((prev) => [...prev.filter((r) => r.id !== repo.id), repo]);
            setSelectedRepoId(repo.id);
          }}
        />
      )}
    </div>
  );
}
