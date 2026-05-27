import { useEffect, useRef, useState } from "react";
import { useFleetStore, serverBase, changeAgent } from "../stores/fleet";
import type { AgentState } from "../stores/fleet";
import { PALETTE, RUNTIMES, RUNTIME_MODELS } from "../lib/constants";
import { Icon } from "./Icons";

interface Props {
  agent: AgentState;
  x: number;
  y: number;
  accent: string;
  onClose: () => void;
}

export function CardMenu({ agent, x, y, accent, onClose }: Props) {
  const { setColorOverride } = useFleetStore();
  const ref = useRef<HTMLDivElement>(null);
  const [showRuntimePicker, setShowRuntimePicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const doAction = async (action: string) => {
    onClose();
    try {
      if (action === "kill") {
        await fetch(`${serverBase.http}/api/fleet/kill`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: agent.name }) });
      } else if (action === "clear") {
        await fetch(`${serverBase.http}/api/agents/${agent.name}/clear`, { method: "POST", headers: { "Content-Type": "application/json" } });
      }
    } catch {}
  };

  const handleRuntimeChange = async (rt: string) => {
    setShowRuntimePicker(false);
    await changeAgent(agent.name, "runtime", rt);
  };

  const handleModelChange = async (model: string) => {
    setShowModelPicker(false);
    await changeAgent(agent.name, "model", model);
  };

  const isDispatcher = agent.name === "_dispatcher";
  const models = RUNTIME_MODELS[agent.runtime] || [];

  return (
    <div ref={ref} className="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {/* Runtime / Model section */}
      {!isDispatcher && (
        <>
          <div className="menu-section-label">Runtime</div>
          <button className="menu-item" onClick={() => { setShowRuntimePicker(!showRuntimePicker); setShowModelPicker(false); }}>
            <span className="mi-ico"><Icon name="zap" size={13} /></span>
            <span>{agent.runtime}</span>
            <span className="mi-chevron">▸</span>
          </button>
          {showRuntimePicker && (
            <div className="menu-sub">
              {RUNTIMES.map((rt) => (
                <button
                  key={rt}
                  className={"menu-sub-item" + (rt === agent.runtime ? " active" : "")}
                  onClick={() => handleRuntimeChange(rt)}
                >
                  {rt}
                  {rt === agent.runtime && <span className="mi-check">✓</span>}
                </button>
              ))}
            </div>
          )}

          <div className="menu-section-label">Model</div>
          <button className="menu-item" onClick={() => { setShowModelPicker(!showModelPicker); setShowRuntimePicker(false); }}>
            <span className="mi-ico"><Icon name="cpu" size={13} /></span>
            <span className="mi-model-name">{agent.model}</span>
            <span className="mi-chevron">▸</span>
          </button>
          {showModelPicker && (
            <div className="menu-sub">
              {models.map((m) => (
                <button
                  key={m}
                  className={"menu-sub-item" + (m === agent.model ? " active" : "")}
                  onClick={() => handleModelChange(m)}
                >
                  {m}
                  {m === agent.model && <span className="mi-check">✓</span>}
                </button>
              ))}
            </div>
          )}

          <div className="menu-divider"></div>
        </>
      )}

      <div className="menu-section-label">Accent color</div>
      <div className="menu-colors">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={"swatch" + (c.toLowerCase() === accent.toLowerCase() ? " selected" : "")}
            style={{ background: c }}
            onClick={() => { setColorOverride(agent.name, c); onClose(); }}
          />
        ))}
      </div>

      <div className="menu-divider"></div>

      <button className="menu-item" onClick={() => doAction("clear")}>
        <span className="mi-ico"><Icon name="stop" size={13} /></span>
        <span>Clear session</span>
      </button>
      <button className="menu-item danger" onClick={() => doAction("kill")}>
        <span className="mi-ico"><Icon name="trash" size={13} /></span>
        <span>Kill agent</span>
      </button>
    </div>
  );
}
