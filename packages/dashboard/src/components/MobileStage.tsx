import { useEffect, useMemo, useRef, useState } from "react";
import { useFleetStore, fetchSessionEvents } from "../stores/fleet";
import { SessionCard } from "./SessionCard";
import { PixelThronglet } from "./PixelThronglet";
import { generateThronglet, statusToMood } from "../lib/thronglet";
import { STATUS_META } from "../lib/constants";

export function MobileStage() {
  const { agents, currentWorkspace, activeAgent, selectAndActivate } = useFleetStore();
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  const rawFiltered = currentWorkspace === "all"
    ? agents
    : agents.filter((a) => a.workspace === currentWorkspace);

  const sorted = useMemo(() => [
    ...rawFiltered.filter((a) => a.name === "_dispatcher"),
    ...rawFiltered.filter((a) => a.name !== "_dispatcher"),
  ], [rawFiltered]);

  const active = sorted.find((a) => a.name === activeAgent) || sorted[0];

  useEffect(() => {
    if (sorted.length > 0 && !sorted.find((a) => a.name === activeAgent)) {
      selectAndActivate(sorted[0].name);
    }
  }, [sorted, activeAgent, selectAndActivate]);

  useEffect(() => {
    if (active) {
      const viewing = useFleetStore.getState().viewingSession[active.name];
      fetchSessionEvents(active.name, viewing || active.currentSessionId);
    }
  }, [active?.name, active?.currentSessionId]);

  useEffect(() => {
    if (!tabStripRef.current || !active || headerCollapsed) return;
    const activeTab = tabStripRef.current.querySelector(`[data-agent="${active.name}"]`) as HTMLElement | null;
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [active?.name, headerCollapsed]);

  const handleTabSelect = (name: string) => {
    selectAndActivate(name);
    setHeaderCollapsed(true);
  };

  if (sorted.length === 0) {
    return (
      <div className="mobile-stage">
        <div className="mobile-empty">No throngs hatched yet</div>
      </div>
    );
  }

  const activeMeta = active ? (STATUS_META[active.status] || STATUS_META.waiting) : null;
  const activeDisplayName = active ? (active.name === "_dispatcher" ? "Orix" : active.name) : "";

  return (
    <div className="mobile-stage">
      {headerCollapsed ? (
        <button className="mobile-collapsed-header" onClick={() => setHeaderCollapsed(false)}>
          <span className="mch-dot" style={{ background: activeMeta?.color }} />
          <span className="mch-name">{activeDisplayName}</span>
          <span className="mch-status">{activeMeta?.label}</span>
          <span className="mch-count">{sorted.length} throngs</span>
          <span className="mch-expand">▾</span>
        </button>
      ) : (
        <div className="mobile-tabs" ref={tabStripRef}>
          <button className="mobile-tab-collapse" onClick={() => setHeaderCollapsed(true)}>▴</button>
          {sorted.map((agent) => (
            <AgentTab
              key={agent.name}
              name={agent.name}
              status={agent.status}
              isActive={active?.name === agent.name}
              isDispatcher={agent.name === "_dispatcher"}
              lastActivity={agent.lastActivity}
              onSelect={() => handleTabSelect(agent.name)}
            />
          ))}
        </div>
      )}
      <div className="mobile-card-container">
        {active && <SessionCard key={active.name} agent={active} mobile />}
      </div>
    </div>
  );
}

function AgentTab({ name, status, isActive, isDispatcher, lastActivity, onSelect }: {
  name: string;
  status: string;
  isActive: boolean;
  isDispatcher: boolean;
  lastActivity: string;
  onSelect: () => void;
}) {
  const spec = useMemo(() => generateThronglet(name), [name]);
  const mood = statusToMood(status, lastActivity);
  const meta = STATUS_META[status] || STATUS_META.waiting;
  const displayName = isDispatcher ? "Orix" : name;

  return (
    <button
      className={"mobile-tab" + (isActive ? " active" : "") + (isDispatcher ? " dispatch" : "")}
      data-agent={name}
      onClick={onSelect}
    >
      <div className="mobile-tab-avatar">
        <PixelThronglet spec={spec} mood={mood} size={24} />
      </div>
      <span className="mobile-tab-name">{displayName}</span>
      <span className="mobile-tab-dot" style={{ background: meta.color }} />
    </button>
  );
}
