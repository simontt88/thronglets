import { useState, useRef } from "react";
import { useFleetStore, getAgentAccent } from "../stores/fleet";
import { AGENT_COLORS, AGENT_GLYPHS, getAgentColor } from "../lib/constants";
import { Icon } from "./Icons";

export function Dispatcher() {
  const { agents, dispatcherOpen, toggleDispatcher, currentWorkspace } = useFleetStore();
  const [pos, setPos] = useState({ x: -1, y: 76 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  if (!dispatcherOpen) return null;

  const filtered = currentWorkspace === "all" ? agents : agents.filter((a) => a.workspace === currentWorkspace);
  const working = filtered.filter((a) => a.status === "working");
  const errors = filtered.filter((a) => a.status === "error");
  const idle = filtered.filter((a) => a.status === "idle");

  // Per-runtime breakdown
  const runtimes = ["cursor", "claude-code", "codex"];
  const fleet = runtimes.map((rt) => {
    const mine = filtered.filter((a) => a.runtime === rt);
    return {
      runtime: rt,
      glyph: AGENT_GLYPHS[rt] || "?",
      color: AGENT_COLORS[rt] || "#888",
      total: mine.length,
      working: mine.filter((a) => a.status === "working").length,
      idle: mine.filter((a) => a.status === "idle").length,
      error: mine.filter((a) => a.status === "error").length,
    };
  }).filter((f) => f.total > 0);

  const onHeadMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev: MouseEvent) => {
      const ds = dragRef.current;
      if (!ds) return;
      setPos({ x: ds.origX + (ev.clientX - ds.startX), y: Math.max(8, ds.origY + (ev.clientY - ds.startY)) });
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const style: React.CSSProperties = pos.x < 0
    ? { right: 14, top: pos.y }
    : { left: pos.x, top: pos.y };

  return (
    <div className="dispatcher-float" style={style}>
      <div className="df-head" onMouseDown={onHeadMouseDown}>
        <div className="orb-mini"></div>
        <div className="df-title">
          Fleet status
          <span className="df-sub">{filtered.length} agents</span>
        </div>
        <button className="df-close" onClick={toggleDispatcher}>
          <Icon name="x" size={13} />
        </button>
      </div>

      {/* Stats */}
      <div className="df-stats">
        <div className="df-stat">
          <div className="v">
            {working.length}
            <span className="u">/ {filtered.length}</span>
            {working.length > 0 && <span className="pulse-dot working"></span>}
          </div>
          <div className="k">in flight</div>
        </div>
        <div className="df-stat">
          <div className="v">
            {errors.length}
            {errors.length > 0 && <span className="pulse-dot waiting"></span>}
          </div>
          <div className="k">errors</div>
        </div>
        <div className="df-stat">
          <div className="v">{idle.length}</div>
          <div className="k">idle</div>
        </div>
      </div>

      <div className="df-scroll">
        {/* Per-runtime fleet */}
        {fleet.length > 0 && (
          <div className="df-section">
            <div className="df-section-label">
              <span>Agent fleet</span>
              <span className="df-section-aux">{filtered.length} active</span>
            </div>
            <div className="df-fleet">
              {fleet.map((f) => (
                <div key={f.runtime} className="df-fleet-row">
                  <div className="df-fleet-avatar" style={{ background: `linear-gradient(140deg, ${f.color}, color-mix(in oklab, ${f.color} 55%, #2a2d36))` }}>
                    {f.glyph}
                  </div>
                  <div className="df-fleet-meta">
                    <div className="df-fleet-name">
                      <span>{f.runtime}</span>
                      <span className="df-fleet-total">{f.total}</span>
                    </div>
                    <div className="df-fleet-bar">
                      {f.working > 0 && <span className="seg working" style={{ flex: f.working }}></span>}
                      {f.error > 0 && <span className="seg waiting" style={{ flex: f.error }}></span>}
                      {f.idle > 0 && <span className="seg idle" style={{ flex: f.idle }}></span>}
                      {f.total === 0 && <span className="seg ghost" style={{ flex: 1 }}></span>}
                    </div>
                    <div className="df-fleet-counts">
                      <span><span className="d working"></span>{f.working} working</span>
                      <span><span className="d idle"></span>{f.idle} idle</span>
                      <span><span className="d error"></span>{f.error} error</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Running now */}
        {working.length > 0 && (
          <div className="df-section">
            <div className="df-section-label">
              <span>Running now</span>
              <span className="df-section-aux">{working.length}</span>
            </div>
            <div className="df-list">
              {working.map((a) => (
                <div key={a.name} className="df-row running">
                  <span className="df-row-dot pulsing" style={{ background: getAgentAccent(a), color: getAgentAccent(a) }}></span>
                  <div className="df-row-body">
                    <div className="df-row-title">
                      <span className="codename">{a.runtime}</span>
                      <span className="sep">·</span>
                      <span className="name">{a.name}</span>
                      {a.sessionName && <span className="df-session-name">「{a.sessionName}」</span>}
                    </div>
                    <div className="df-row-sub">{a.inferred || "processing..."}</div>
                    <div className="df-progress"><span className="df-progress-bar" style={{ background: getAgentAccent(a) }}></span></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <div className="df-section">
            <div className="df-section-label">
              <span>Needs attention</span>
              <span className="df-section-aux">{errors.length}</span>
            </div>
            <div className="df-list">
              {errors.map((a) => (
                <div key={a.name} className="df-row">
                  <span className="df-row-dot" style={{ background: "var(--st-error)" }}></span>
                  <div className="df-row-body">
                    <div className="df-row-title">
                      <span className="codename">{a.runtime}</span>
                      <span className="sep">·</span>
                      <span className="name">{a.name}</span>
                      {a.sessionName && <span className="df-session-name">「{a.sessionName}」</span>}
                    </div>
                    <div className="df-row-sub">{a.inferred || "error"}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Idle */}
        {idle.length > 0 && (
          <div className="df-section">
            <div className="df-section-label">
              <span>Idle</span>
              <span className="df-section-aux">{idle.length}</span>
            </div>
            <div className="df-list">
              {idle.map((a) => (
                <div key={a.name} className="df-row">
                  <span className="df-row-dot" style={{ background: "var(--st-idle)" }}></span>
                  <div className="df-row-body">
                    <div className="df-row-title">
                      <span className="codename">{a.runtime}</span>
                      <span className="sep">·</span>
                      <span className="name">{a.name}</span>
                      {a.sessionName && <span className="df-session-name">「{a.sessionName}」</span>}
                    </div>
                    <div className="df-row-sub">{a.inferred || "standing by"}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
