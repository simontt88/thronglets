import { useFleetStore, getAgentAccent, pokeDispatcher } from "../stores/fleet";
import { AGENT_COLORS } from "../lib/constants";
import { Icon } from "./Icons";
import { PixelThronglet } from "./PixelThronglet";
import { generateThronglet, statusToMood } from "../lib/thronglet";

const RUNTIME_LABELS: Record<string, string> = {
  cursor: "in-IDE",
  "claude-code": "terminal",
  codex: "agentic",
};

export function MobileDispatcher() {
  const { agents, dispatcherOpen, toggleDispatcher, currentWorkspace } = useFleetStore();

  if (!dispatcherOpen) return null;

  const filtered = currentWorkspace === "all" ? agents : agents.filter((a) => a.workspace === currentWorkspace);
  const working = filtered.filter((a) => a.status === "working");
  const errors = filtered.filter((a) => a.status === "error");
  const waiting = filtered.filter((a) => a.status === "waiting");
  const sleeping = filtered.filter((a) => a.status === "sleeping");
  const dead = filtered.filter((a) => a.status === "stopped");

  const runtimes = ["cursor", "claude-code", "codex"];
  const fleet = runtimes.map((rt) => {
    const mine = filtered.filter((a) => a.runtime === rt);
    return {
      runtime: rt,
      label: RUNTIME_LABELS[rt] || rt,
      color: AGENT_COLORS[rt] || "#888",
      total: mine.length,
      working: mine.filter((a) => a.status === "working").length,
      waiting: mine.filter((a) => a.status === "waiting").length,
      sleeping: mine.filter((a) => a.status === "sleeping").length,
      error: mine.filter((a) => a.status === "error").length,
    };
  }).filter((f) => f.total > 0);

  return (
    <div className="mobile-dispatch-overlay" onClick={toggleDispatcher}>
      <div className="mobile-dispatch-panel" onClick={(e) => e.stopPropagation()}>
        <div className="df-head">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, flexShrink: 0 }}>
            <PixelThronglet spec={generateThronglet("_dispatcher")} mood={working.length > 0 ? "working" : errors.length > 0 ? "skeptical" : "happy"} size={24} />
          </div>
          <div className="df-title">
            Habitat Status
            <span className="df-sub">{filtered.length} thronglets</span>
          </div>
          <button className="df-poke" onClick={pokeDispatcher} title="Poke dispatcher">
            👉
          </button>
          <button className="df-close" onClick={toggleDispatcher}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="df-stats">
          <div className="df-stat">
            <div className="v">
              {working.length}
              <span className="u">/ {filtered.length}</span>
              {working.length > 0 && <span className="pulse-dot working"></span>}
            </div>
            <div className="k">grinding</div>
          </div>
          <div className="df-stat">
            <div className="v">
              {errors.length}
              {errors.length > 0 && <span className="pulse-dot waiting"></span>}
            </div>
            <div className="k">distressed</div>
          </div>
          <div className="df-stat">
            <div className="v">{waiting.length}</div>
            <div className="k">waiting</div>
          </div>
          <div className="df-stat">
            <div className="v">{sleeping.length + dead.length}</div>
            <div className="k">sleeping</div>
          </div>
        </div>

        <div className="df-scroll">
          {fleet.length > 0 && (
            <div className="df-section">
              <div className="df-section-label">
                <span>Species</span>
                <span className="df-section-aux">{filtered.length} alive</span>
              </div>
              <div className="df-fleet">
                {fleet.map((f) => (
                  <div key={f.runtime} className="df-fleet-row">
                    <div className="df-fleet-avatar" style={{ background: "transparent" }}>
                      <PixelThronglet spec={generateThronglet(f.runtime)} mood="idle" size={30} />
                    </div>
                    <div className="df-fleet-meta">
                      <div className="df-fleet-name">
                        <span>{f.label}</span>
                        <span className="df-fleet-total">{f.total}</span>
                      </div>
                      <div className="df-fleet-bar">
                        {f.working > 0 && <span className="seg working" style={{ flex: f.working }}></span>}
                        {f.waiting > 0 && <span className="seg waiting" style={{ flex: f.waiting }}></span>}
                        {f.sleeping > 0 && <span className="seg sleeping" style={{ flex: f.sleeping }}></span>}
                        {f.error > 0 && <span className="seg error" style={{ flex: f.error }}></span>}
                        {f.total === 0 && <span className="seg ghost" style={{ flex: 1 }}></span>}
                      </div>
                      <div className="df-fleet-counts">
                        <span><span className="d working"></span>{f.working} grinding</span>
                        <span><span className="d sleeping"></span>{f.sleeping} sleeping</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {working.length > 0 && (
            <div className="df-section">
              <div className="df-section-label">
                <span>Grinding</span>
                <span className="df-section-aux">{working.length}</span>
              </div>
              <div className="df-list">
                {working.map((a) => (
                  <div key={a.name} className="df-row running">
                    <span className="df-row-dot pulsing" style={{ background: getAgentAccent(a), color: getAgentAccent(a) }}></span>
                    <div className="df-row-body">
                      <div className="df-row-title">
                        <span className="codename">{a.name}</span>
                        {a.sessionName && <span className="df-session-name">{a.sessionName}</span>}
                      </div>
                      <div className="df-row-sub">{a.inferred || "working..."}</div>
                      <div className="df-progress"><span className="df-progress-bar" style={{ background: getAgentAccent(a) }}></span></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div className="df-section">
              <div className="df-section-label">
                <span>Needs Help</span>
                <span className="df-section-aux">{errors.length}</span>
              </div>
              <div className="df-list">
                {errors.map((a) => (
                  <div key={a.name} className="df-row">
                    <span className="df-row-dot" style={{ background: "var(--st-error)" }}></span>
                    <div className="df-row-body">
                      <div className="df-row-title"><span className="codename">{a.name}</span></div>
                      <div className="df-row-sub">{a.inferred || "error"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {waiting.length > 0 && (
            <div className="df-section">
              <div className="df-section-label">
                <span>Waiting</span>
                <span className="df-section-aux">{waiting.length}</span>
              </div>
              <div className="df-list">
                {waiting.map((a) => (
                  <div key={a.name} className="df-row">
                    <span className="df-row-dot" style={{ background: "var(--st-waiting)" }}></span>
                    <div className="df-row-body">
                      <div className="df-row-title"><span className="codename">{a.name}</span></div>
                      <div className="df-row-sub">{a.inferred || "ready"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sleeping.length > 0 && (
            <div className="df-section">
              <div className="df-section-label">
                <span>Sleeping</span>
                <span className="df-section-aux">{sleeping.length}</span>
              </div>
              <div className="df-list">
                {sleeping.map((a) => (
                  <div key={a.name} className="df-row">
                    <span className="df-row-dot" style={{ background: "var(--st-sleeping)" }}></span>
                    <div className="df-row-body">
                      <div className="df-row-title"><span className="codename">{a.name}</span></div>
                      <div className="df-row-sub">{a.inferred || "zzz"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
