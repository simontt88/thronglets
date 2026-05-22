import { useEffect, useRef } from "react";
import { useFleetStore, fetchSessionEvents, fetchSessionList } from "../stores/fleet";

export function SessionView() {
  const { selectedAgent, selectedSession, sessionEvents, sessionList, agents } = useFleetStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const agent = agents.find((a) => a.name === selectedAgent);
  const currentSessionId = agent?.currentSessionId;
  const activeSession = selectedSession || currentSessionId;
  const isArchived = activeSession !== currentSessionId;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [sessionEvents]);

  const handleSessionChange = (sessionId: string) => {
    useFleetStore.getState().selectSession(sessionId === currentSessionId ? null : sessionId);
    if (selectedAgent) fetchSessionEvents(selectedAgent, sessionId);
  };

  if (!selectedAgent || !agent) return null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "12px 20px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}>
        <div>
          <span style={{ fontWeight: 600, fontSize: "1rem" }}>{selectedAgent}</span>
          <span style={{ color: "var(--text-dim)", fontSize: "0.8rem", marginLeft: "8px" }}>
            {agent.runtime} · {agent.model}
          </span>
          {isArchived && (
            <span style={{
              marginLeft: "8px",
              fontSize: "0.65rem",
              padding: "2px 6px",
              borderRadius: "4px",
              background: "rgba(245,158,11,0.15)",
              color: "var(--amber)",
            }}>
              ARCHIVED
            </span>
          )}
        </div>

        {/* Session switcher */}
        {sessionList.length > 1 && (
          <select
            value={activeSession || ""}
            onChange={(e) => handleSessionChange(e.target.value)}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              color: "var(--text)",
              padding: "4px 8px",
              fontSize: "0.75rem",
              fontFamily: "var(--mono)",
            }}
          >
            {sessionList.map((sid) => (
              <option key={sid} value={sid}>
                {sid === currentSessionId ? `${sid} (active)` : sid}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Terminal output */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          fontFamily: "var(--mono)",
          fontSize: "0.8rem",
          lineHeight: "1.7",
        }}
      >
        {sessionEvents.length === 0 && (
          <div style={{ color: "var(--text-dim)", padding: "40px 0", textAlign: "center" }}>
            {isArchived ? "Archived session — read only" : "No messages yet. Send one via Telegram."}
          </div>
        )}
        {sessionEvents.map((event, i) => (
          <MessageLine key={i} event={event} />
        ))}
      </div>
    </div>
  );
}

function MessageLine({ event }: { event: { ts: string; type: string; text?: string; error?: string } }) {
  const time = new Date(event.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const isUser = event.type === "user_message";
  const isError = event.type === "error";
  const color = isUser ? "var(--accent)" : isError ? "var(--red)" : "var(--text)";
  const prefix = isUser ? "▶" : isError ? "✖" : "◀";
  const content = event.text || event.error || "";

  return (
    <div style={{ marginBottom: "8px", color }}>
      <span style={{ color: "var(--text-dim)", marginRight: "8px" }}>{time}</span>
      <span style={{ marginRight: "6px" }}>{prefix}</span>
      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{content}</span>
    </div>
  );
}
