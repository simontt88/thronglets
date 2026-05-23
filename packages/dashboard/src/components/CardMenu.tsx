import { useEffect, useRef } from "react";
import { useFleetStore, serverBase } from "../stores/fleet";
import type { AgentState } from "../stores/fleet";
import { PALETTE } from "../lib/constants";
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

  return (
    <div ref={ref} className="menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ padding: "6px 10px 2px", fontSize: "9.5px", color: "var(--t-3)", letterSpacing: "0.10em", textTransform: "uppercase", fontWeight: 600 }}>
        Accent color
      </div>
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
