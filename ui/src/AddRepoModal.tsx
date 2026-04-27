import { useState } from "react";
import { addGitRepo, type Repo } from "./api";

interface Props {
  onClose: () => void;
  onAdded: (repo: Repo) => void;
}

export default function AddRepoModal({ onClose, onAdded }: Props) {
  const [urlValue, setUrlValue] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const repo = await addGitRepo(urlValue.trim(), name.trim() || undefined);
      onAdded(repo);
      onClose();
    } catch (err: any) {
      setError(err.message ?? "Failed to add repo");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          width: 480,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>Import repo</h2>
          <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 4 }}>
            Register a remote git repository with Archon Hub. No local clone is
            required — each workflow run fetches the repo from GitHub on demand.
          </p>
        </div>

        <Field
          label="Git URL"
          placeholder="git@github.com:org/repo.git"
          value={urlValue}
          onChange={setUrlValue}
          required
          mono
        />

        <Field
          label="Display name (optional)"
          placeholder="Defaults to repo name"
          value={name}
          onChange={setName}
        />

        {error && (
          <p style={{ color: "var(--error)", fontSize: 13 }}>{error}</p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 16px",
              background: "transparent",
              color: "var(--text-dim)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: "8px 16px",
              background: submitting ? "var(--border)" : "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Importing..." : "Import"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 600 }}>
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        style={{
          padding: "10px 12px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text)",
          fontSize: 13,
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          outline: "none",
        }}
      />
    </label>
  );
}
