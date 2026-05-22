import { useFleetStore, fetchSessionEvents, fetchSessionList } from "../stores/fleet";
import type { AgentState } from "../stores/fleet";

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`;
  return `${Math.round(diff / 3600_000)}h`;
}

function StatusDot({ status }: { status: string }) {
  const color = status === "working" ? "var(--amber)"
    : status === "error" ? "var(--red)"
    : "var(--green)";
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%",
      background: color,
      display: "inline-block",
      animation: status === "working" ? "pulse 1.5s infinite" : undefined,
    }} />
  );
}

function AgentCard({ agent }: { agent: AgentState }) {
  const { selectedAgent, selectAgent } = useFleetStore();
  const isSelected = selectedAgent === agent.name;

  return (
    <div
      onClick={() => {
        selectAgent(agent.name);
        fetchSessionEvents(agent.name);
        fetchSessionList(agent.name);
      }}
      style={{
        padding: "16px",
        border: `1px solid ${isSelected ? "var(--accent)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        background: isSelected ? "rgba(59,130,246,0.08)" : "var(--surface)",
        cursor: "pointer",
        transition: "all 0.15s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <span style={{ fontWeight: 600 }}>{agent.name}</span>
        <StatusDot status={agent.status} />
      </div>

      <div style={{ display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap" }}>
        <Badge text={agent.runtime} color="var(--accent)" />
        <Badge text={agent.workspace} color="#6366f1" />
      </div>

      <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
        {agent.model} · {agent.messageCount} msgs · {timeSince(agent.lastActivity)} ago
      </div>
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{
      fontSize: "0.65rem",
      padding: "2px 6px",
      borderRadius: "4px",
      background: `${color}22`,
      color,
      fontWeight: 500,
      textTransform: "uppercase",
      letterSpacing: "0.03em",
    }}>
      {text}
    </span>
  );
}

export function FleetPanel() {
  const { agents } = useFleetStore();

  return (
    <aside style={{
      width: "320px",
      minWidth: "280px",
      borderRight: "1px solid var(--border)",
      padding: "16px",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    }}>
      <div style={{ fontSize: "0.8rem", color: "var(--text-dim)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Fleet · {agents.length} agent{agents.length !== 1 ? "s" : ""}
      </div>
      {agents.length === 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: "0.85rem", padding: "20px 0" }}>
          No agents running.<br />Use Telegram /new to spawn one.
        </div>
      )}
      {agents.map((agent) => (
        <AgentCard key={agent.name} agent={agent} />
      ))}
      <style>{`@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }`}</style>
    </aside>
  );
}
