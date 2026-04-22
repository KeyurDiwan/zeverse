import { useCallback, useEffect, useRef, useState } from "react";
import {
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

const STATUS_COLORS: Record<RunStatus, string> = {
  queued: "var(--warning)",
  running: "var(--accent)",
  success: "var(--success)",
  failed: "var(--error)",
};

const SELECTED_REPO_KEY = "archon-hub:selected-repo";
const SELECTED_WORKFLOW_KEY = "archon-hub:selected-workflow";

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
  const [prompt, setPrompt] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [logs, setLogs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddRepo, setShowAddRepo] = useState(false);
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

  const handleRun = useCallback(async () => {
    if (!selectedRepoId || !selectedWorkflow || !prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    setLogs("");
    setRun(null);
    logOffset.current = 0;
    try {
      const id = await triggerRun(selectedRepoId, selectedWorkflow, prompt.trim());
      setRunId(id);
    } catch (err: any) {
      setError(`Failed to start workflow run: ${err.message ?? "unknown error"}`);
    } finally {
      setSubmitting(false);
    }
  }, [selectedRepoId, selectedWorkflow, prompt]);

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
      if (!confirm("Remove this repo from Archon Hub? Files on disk are not deleted.")) {
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
  const selectedWorkflowMeta = workflows.find((w) => w.name === selectedWorkflow);

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
                  title={repo.path}
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
                    {repo.path}
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
                {selectedRepo ? `${selectedRepo.path}/.archon/workflows/` : ".archon/workflows/"}
              </code>
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
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want this workflow to do..."
            rows={3}
            style={{
              width: "100%",
              padding: "12px 14px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text)",
              fontSize: 14,
              fontFamily: "inherit",
              resize: "vertical",
              outline: "none",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
          />
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
              disabled={
                !selectedRepoId || !selectedWorkflow || !prompt.trim() || submitting
              }
              style={{
                padding: "8px 24px",
                background:
                  !selectedRepoId || !selectedWorkflow || !prompt.trim() || submitting
                    ? "var(--border)"
                    : "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                cursor:
                  !selectedRepoId || !selectedWorkflow || !prompt.trim() || submitting
                    ? "not-allowed"
                    : "pointer",
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
                  ? "Select a workflow, enter a prompt, and click Run."
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
