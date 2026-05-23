import { useRef, useState, useEffect } from "react";
import { useFleetStore, fetchSessionEvents, getAgentAccent } from "../stores/fleet";
import { packItems } from "../lib/pack";
import { SessionCard } from "./SessionCard";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { Dispatcher } from "./Dispatcher";

export function GridStage() {
  const { agents, currentWorkspace, cols, cardSizes } = useFleetStore();
  const innerRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(800);

  const filtered = currentWorkspace === "all"
    ? agents
    : agents.filter((a) => a.workspace === currentWorkspace);

  const agentKey = filtered.map((a) => a.name).join(",");

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        setStageW(Math.max(400, e.contentRect.width - 28));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    filtered.forEach((a) => {
      const viewing = useFleetStore.getState().viewingSession[a.name];
      const sid = viewing || a.currentSessionId;
      fetchSessionEvents(a.name, sid);
    });
  }, [agentKey]);

  const gap = 10;
  const items = filtered.map((a) => ({
    id: a.name,
    colSpan: cardSizes[a.name]?.colSpan || 1,
    height: cardSizes[a.name]?.height || 520,
  }));

  const { placements, totalH } = packItems(items, stageW, cols, gap);

  return (
    <div className="stage-wrap">
      <div className="stage">
        <div className="stage-inner" ref={innerRef}>
          <WorkspaceHeader />
          <div className="grid-stage" style={{ height: totalH }}>
            {filtered.map((agent) => {
              const p = placements[agent.name];
              if (!p) return null;
              return <SessionCard key={agent.name} agent={agent} placement={p} />;
            })}
          </div>
        </div>
      </div>
      <Dispatcher />
    </div>
  );
}
