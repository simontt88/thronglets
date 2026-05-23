import { useState, useRef, useEffect } from "react";
import { useFleetStore, fetchSessionList, fetchSessionEvents, getAgentAccent } from "../stores/fleet";
import type { AgentState, SessionEvent } from "../stores/fleet";
import { getAgentGlyph, STATUS_META } from "../lib/constants";
import { renderMarkdown } from "../lib/markdown";
import { Icon } from "./Icons";
import { CardMenu } from "./CardMenu";
import type { Placement } from "../lib/pack";

interface Props {
  agent: AgentState;
  placement: Placement;
}

export function SessionCard({ agent, placement }: Props) {
  const {
    selectedAgent, selectAgent, viewingSession, sessionLists, sessionEvents,
    setViewingSession, clearViewingSession, fontSizes, setFontSize, setActiveAgent,
  } = useFleetStore();

  const accent = getAgentAccent(agent);
  const glyph = getAgentGlyph(agent.runtime);
  const meta = STATUS_META[agent.status] || STATUS_META.idle;
  const isSelected = selectedAgent === agent.name;
  const isWorking = agent.status === "working";

  const viewedSessionId = viewingSession[agent.name];
  const isArchived = !!(viewedSessionId && viewedSessionId !== agent.currentSessionId);
  const sessions = sessionLists[agent.name] || [];
  const events = sessionEvents[agent.name] || [];

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fontSize = fontSizes[agent.name] || 13.5;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length]);

  const handleSessionSwitch = (sid: string) => {
    if (sid === agent.currentSessionId) {
      clearViewingSession(agent.name);
      fetchSessionEvents(agent.name, sid);
    } else {
      setViewingSession(agent.name, sid);
      fetchSessionEvents(agent.name, sid);
    }
    setShowSessionPicker(false);
  };

  const handleOpenSessions = () => {
    fetchSessionList(agent.name);
    setShowSessionPicker(!showSessionPicker);
  };

  return (
    <div
      className={
        "session-card" +
        (isWorking ? " working" : "") +
        (isSelected ? " selected" : "") +
        (isArchived ? " archived" : "")
      }
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.w,
        height: placement.h,
        "--accent": accent,
        "--status-color": meta.color,
        "--card-font-size": `${fontSize}px`,
      } as React.CSSProperties}
      onMouseDown={() => { selectAgent(agent.name); setActiveAgent(agent.name); }}
    >
      {/* Header */}
      <div className="card-head">
        <div className="agent-avatar">{glyph}</div>
        <div className="head-text">
          <div className="session-name">
            <span className="name-text">{agent.name}</span>
            {agent.sessionName && <span className="session-tag">「{agent.sessionName}」</span>}
          </div>
          <div className="session-codename">{agent.runtime} · {agent.model}</div>
        </div>
        <div className="head-actions">
          <div className="font-controls">
            <button onClick={(e) => { e.stopPropagation(); setFontSize(agent.name, fontSize - 1); }} title="Smaller text">−</button>
            <span className="font-size-label">{Math.round(fontSize)}</span>
            <button onClick={(e) => { e.stopPropagation(); setFontSize(agent.name, fontSize + 1); }} title="Larger text">+</button>
          </div>
          <button className="session-switcher" onClick={handleOpenSessions} title="Switch session">
            {(viewedSessionId || agent.currentSessionId).slice(-8)} ▾
          </button>
          <button
            className="ico-btn"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setMenuPos({ x: r.right - 220, y: r.bottom + 4 });
            }}
          >
            <Icon name="dots" size={14} />
          </button>
        </div>
      </div>

      {/* Status */}
      <div className="status-row">
        {isArchived ? (
          <span className="archived-badge">ARCHIVED</span>
        ) : (
          <span className={"status-chip" + (isWorking ? " working" : "")}>
            <span className="sdot"></span>
            {meta.label}
          </span>
        )}
        <span className="inferred-text">{agent.inferred || agent.workspacePath || `${agent.messageCount} msgs`}</span>
      </div>

      {/* Conversation — the main focus */}
      <div className="conversation-area" ref={scrollRef}>
        {events.length > 0 ? (
          events.map((ev, i) => (
            <MessageBubble key={i} event={ev} accent={accent} />
          ))
        ) : (
          <div className="conversation-empty">
            {isArchived ? "No messages in this session" : "Waiting for first message…"}
          </div>
        )}
        {isWorking && !isArchived && (
          <div className="msg-row msg-agent">
            <div className="msg-indicator">
              <span className="typing-dots">
                <span></span><span></span><span></span>
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="resize-handle br"></div>

      {/* Session picker dropdown */}
      {showSessionPicker && (
        <div className="session-dropdown" onMouseDown={(e) => e.stopPropagation()}>
          <div className="session-dropdown-head">Sessions for {agent.name}</div>
          {/* Always show the active session first */}
          <button
            className={"session-dropdown-item" + ((!viewedSessionId || viewedSessionId === agent.currentSessionId) ? " active" : "")}
            onClick={() => handleSessionSwitch(agent.currentSessionId)}
          >
            <span className="session-dropdown-id">{agent.currentSessionId}</span>
            <span className="session-dropdown-badge">active</span>
          </button>
          {/* Archived sessions */}
          {sessions
            .filter((sid) => sid !== agent.currentSessionId)
            .map((sid) => (
              <button
                key={sid}
                className={"session-dropdown-item" + (viewedSessionId === sid ? " active" : "")}
                onClick={() => handleSessionSwitch(sid)}
              >
                <span className="session-dropdown-id">{sid}</span>
              </button>
            ))}
          {sessions.filter((s) => s !== agent.currentSessionId).length === 0 && (
            <div style={{ padding: "6px 8px", fontSize: "10.5px", color: "var(--t-4)" }}>No archived sessions</div>
          )}
        </div>
      )}

      {/* Context menu */}
      {menuPos && (
        <CardMenu
          agent={agent}
          x={menuPos.x}
          y={menuPos.y}
          accent={accent}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}

function MessageBubble({ event, accent }: { event: SessionEvent; accent: string }) {
  const isUser = event.type === "user_message";
  const isError = event.type === "error";
  const text = event.text || event.error || "";

  if (!text) return null;

  return (
    <div className={`msg-row ${isUser ? "msg-user" : "msg-agent"}${isError ? " msg-error" : ""}`}>
      <div className="msg-label">{isUser ? "▶ you" : isError ? "✕ error" : "◀ agent"}</div>
      <div className="msg-body">
        {isUser ? text : renderMarkdown(text)}
      </div>
      <div className="msg-time">{formatTime(event.ts)}</div>
    </div>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
