import { useState, useRef, useEffect } from "react";
import { useFleetStore, spawnAgent } from "../stores/fleet";
import { AGENT_COLORS, AGENT_ROLES, getAgentGlyph } from "../lib/constants";
import { Icon } from "./Icons";

const RUNTIMES = [
  { id: "cursor", label: "Cursor", desc: "in-IDE edits · refactors · review" },
  { id: "claude-code", label: "Claude Code", desc: "terminal · multi-step sweeps · synthesis" },
  { id: "codex", label: "Codex", desc: "automation · planning · long-running jobs" },
];

export function SpawnDialog() {
  const { spawnDialogOpen, setSpawnDialogOpen, workspaces, agents } = useFleetStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState("cursor");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState("");
  const [spawning, setSpawning] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (spawnDialogOpen) {
      setStep(0);
      setName("");
      setRuntime("cursor");
      setWorkspace(workspaces[0]?.alias || "");
      setError("");
      setSpawning(false);
      setTimeout(() => nameRef.current?.focus(), 80);
    }
  }, [spawnDialogOpen]);

  const close = () => setSpawnDialogOpen(false);

  const validateName = () => {
    const n = name.trim();
    if (!n) { setError("Name is required"); return false; }
    if (!/^[a-z0-9_-]+$/i.test(n)) { setError("Letters, numbers, hyphens, underscores only"); return false; }
    if (agents.some((a) => a.name === n)) { setError(`Agent "${n}" already exists`); return false; }
    setError("");
    return true;
  };

  const handleNext = () => {
    if (step === 0 && !validateName()) return;
    if (step < 2) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) { setStep(step - 1); setError(""); }
  };

  const handleSpawn = async () => {
    setSpawning(true);
    setError("");
    try {
      await spawnAgent(name.trim(), runtime, workspace || workspaces[0]?.alias || "cwd");
      close();
    } catch (e) {
      setError(String(e));
      setSpawning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      e.preventDefault();
      if (step === 2) handleSpawn();
      else handleNext();
    }
  };

  if (!spawnDialogOpen) return null;

  const accentColor = AGENT_COLORS[runtime] || "#8b8e9a";

  return (
    <div className="spawn-overlay" onMouseDown={close}>
      <div className="spawn-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="spawn-head">
          <div className="spawn-glyph" style={{ background: accentColor }}>{getAgentGlyph(runtime)}</div>
          <div className="spawn-title">Spawn Agent</div>
          <button className="spawn-close" onClick={close}><Icon name="x" size={14} /></button>
        </div>

        <div className="spawn-steps">
          {[0, 1, 2].map((s) => (
            <div key={s} className={"spawn-step-dot" + (s === step ? " active" : "") + (s < step ? " done" : "")} />
          ))}
        </div>

        <div className="spawn-body">
          {step === 0 && (
            <div className="spawn-section">
              <label className="spawn-label">Agent Name</label>
              <input
                ref={nameRef}
                className="spawn-input"
                placeholder="e.g. alice, bob-2, refactor-agent"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(""); }}
              />
              <p className="spawn-hint">Unique identifier for this agent. Lowercase, hyphens, underscores.</p>
            </div>
          )}

          {step === 1 && (
            <div className="spawn-section">
              <label className="spawn-label">Runtime</label>
              <div className="spawn-runtime-grid">
                {RUNTIMES.map((rt) => (
                  <button
                    key={rt.id}
                    className={"spawn-rt-card" + (runtime === rt.id ? " selected" : "")}
                    style={{ "--rt-color": AGENT_COLORS[rt.id] || "#8b8e9a" } as React.CSSProperties}
                    onClick={() => setRuntime(rt.id)}
                  >
                    <span className="rt-glyph">{getAgentGlyph(rt.id)}</span>
                    <span className="rt-label">{rt.label}</span>
                    <span className="rt-desc">{rt.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="spawn-section">
              <label className="spawn-label">Workspace</label>
              {workspaces.length > 0 ? (
                <div className="spawn-ws-list">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.alias}
                      className={"spawn-ws-item" + (workspace === ws.alias ? " selected" : "")}
                      onClick={() => setWorkspace(ws.alias)}
                    >
                      <span className="ws-alias">{ws.alias}</span>
                      <span className="ws-path">{ws.path}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="spawn-hint">No workspaces configured. Will use default.</p>
              )}

              <div className="spawn-summary">
                <div className="spawn-sum-row">
                  <span className="sum-k">name</span>
                  <span className="sum-v">{name}</span>
                </div>
                <div className="spawn-sum-row">
                  <span className="sum-k">runtime</span>
                  <span className="sum-v">{runtime}</span>
                </div>
                <div className="spawn-sum-row">
                  <span className="sum-k">workspace</span>
                  <span className="sum-v">{workspace || "default"}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {error && <div className="spawn-error">{error}</div>}

        <div className="spawn-footer">
          {step > 0 && (
            <button className="spawn-btn secondary" onClick={handleBack}>Back</button>
          )}
          <div style={{ flex: 1 }} />
          {step < 2 ? (
            <button className="spawn-btn primary" onClick={handleNext}>
              Next
            </button>
          ) : (
            <button className="spawn-btn primary" onClick={handleSpawn} disabled={spawning}>
              {spawning ? "Spawning…" : "Spawn"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
