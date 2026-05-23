import { useState, useEffect, useMemo } from "react";
import { useFleetStore, spawnAgent } from "../stores/fleet";
import { AGENT_COLORS } from "../lib/constants";
import { Icon } from "./Icons";
import { PixelThronglet } from "./PixelThronglet";
import { generateThronglet, generateUniqueName } from "../lib/thronglet";

const RUNTIMES = [
  { id: "cursor",      label: "Cursor",      desc: "in-IDE edits · refactors · review" },
  { id: "claude-code", label: "Claude Code", desc: "terminal · multi-step sweeps · synthesis" },
  { id: "codex",       label: "Codex",       desc: "automation · planning · long-running jobs" },
];

export function SpawnDialog() {
  const { spawnDialogOpen, setSpawnDialogOpen, workspaces, agents } = useFleetStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("preview");
  const [runtime, setRuntime] = useState("cursor");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState("");
  const [spawning, setSpawning] = useState(false);

  useEffect(() => {
    if (spawnDialogOpen) {
      try {
        setName(generateUniqueName(agents.map((a) => a.name)));
      } catch {
        setName("Thronglet");
      }
      setStep(0);
      setRuntime("cursor");
      setWorkspace(workspaces[0]?.alias || "");
      setError("");
      setSpawning(false);
    }
  }, [spawnDialogOpen]);

  const previewSpec = useMemo(() => {
    try { return generateThronglet(name || "preview"); }
    catch { return generateThronglet("preview"); }
  }, [name]);

  if (!spawnDialogOpen) return null;

  const close = () => setSpawnDialogOpen(false);

  const handleNext = () => {
    if (step < 1) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) { setStep(step - 1); setError(""); }
  };

  const reroll = () => {
    setName(generateUniqueName(agents.map((a) => a.name)));
  };

  const handleSpawn = async () => {
    setSpawning(true);
    setError("");
    try {
      await spawnAgent(name.trim(), runtime, workspace || workspaces[0]?.alias || "cwd");
      setSpawnDialogOpen(false);
    } catch (e) {
      setError(String(e));
      setSpawning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setSpawnDialogOpen(false);
    if (e.key === "Enter") {
      e.preventDefault();
      if (step === 1) handleSpawn();
      else handleNext();
    }
  };

  return (
    <div className="spawn-overlay" onMouseDown={() => setSpawnDialogOpen(false)}>
      <div className="spawn-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="spawn-head">
          <div className="spawn-thronglet-preview">
            <PixelThronglet spec={previewSpec} mood="happy" size={48} />
          </div>
          <div className="spawn-title">Hatch a Thronglet</div>
          <button className="spawn-close" onClick={() => setSpawnDialogOpen(false)}><Icon name="x" size={14} /></button>
        </div>

        <div className="spawn-steps">
          {[0, 1].map((s) => (
            <div key={s} className={"spawn-step-dot" + (s === step ? " active" : "") + (s < step ? " done" : "")} />
          ))}
        </div>

        <div className="spawn-body">
          {step === 0 && (
            <div className="spawn-section">
              <label className="spawn-label">Choose Runtime</label>
              <div className="spawn-runtime-grid">
                {RUNTIMES.map((rt) => (
                  <button
                    key={rt.id}
                    className={"spawn-rt-card" + (runtime === rt.id ? " selected" : "")}
                    style={{ "--rt-color": AGENT_COLORS[rt.id] || "#f5c842" } as React.CSSProperties}
                    onClick={() => setRuntime(rt.id)}
                  >
                    <div className="rt-thronglet-mini">
                      <PixelThronglet spec={previewSpec} mood="idle" size={40} />
                    </div>
                    <span className="rt-label">{rt.label}</span>
                    <span className="rt-desc">{rt.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="spawn-section">
              <label className="spawn-label">Choose Habitat</label>
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
                <p className="spawn-hint">No habitats configured. Will use default.</p>
              )}

              <div className="spawn-summary">
                <div className="spawn-sum-row">
                  <span className="sum-k">name</span>
                  <span className="sum-v">
                    {name}
                    <button className="reroll-btn" onClick={reroll} title="Re-roll name">🎲</button>
                  </span>
                </div>
                <div className="spawn-sum-row">
                  <span className="sum-k">trait</span>
                  <span className="sum-v">{previewSpec.trait}</span>
                </div>
                <div className="spawn-sum-row">
                  <span className="sum-k">runtime</span>
                  <span className="sum-v">{runtime}</span>
                </div>
                <div className="spawn-sum-row">
                  <span className="sum-k">habitat</span>
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
          {step < 1 ? (
            <button className="spawn-btn primary" onClick={handleNext}>
              Next
            </button>
          ) : (
            <button className="spawn-btn primary" onClick={handleSpawn} disabled={spawning}>
              {spawning ? "Hatching…" : "🥚 Hatch!"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
