import { useState, useRef, useEffect, useMemo } from "react";
import { useFleetStore, fetchSessionList, fetchSessionEvents, getAgentAccent, setAgentTitle } from "../stores/fleet";
import type { AgentState, SessionEvent } from "../stores/fleet";
import { STATUS_META } from "../lib/constants";
import { renderMarkdown } from "../lib/markdown";
import { Icon } from "./Icons";
import { CardMenu } from "./CardMenu";
import { PixelThronglet } from "./PixelThronglet";
import { generateThronglet, statusToMood } from "../lib/thronglet";
import type { Placement } from "../lib/pack";

interface Props {
  agent: AgentState;
  placement?: Placement;
  mobile?: boolean;
}

export function SessionCard({ agent, placement, mobile }: Props) {
  const {
    selectedAgent, selectAgent, viewingSession, sessionLists, sessionEvents,
    setViewingSession, clearViewingSession, fontSizes, setFontSize, setActiveAgent,
  } = useFleetStore();

  const isDispatcher = agent.name === "_dispatcher";
  const accent = isDispatcher ? "#7c6af7" : getAgentAccent(agent);
  const meta = STATUS_META[agent.status] || STATUS_META.waiting;
  const isSelected = selectedAgent === agent.name;
  const isWorking = agent.status === "working";
  const isDead = agent.status === "stopped" || agent.status === "dead";

  const mood = statusToMood(agent.status, agent.lastActivity);
  const thronglet = useMemo(() => generateThronglet(agent.name), [agent.name]);

  const viewedSessionId = viewingSession[agent.name];
  const isArchived = !!(viewedSessionId && viewedSessionId !== agent.currentSessionId);
  const sessions = sessionLists[agent.name] || [];
  const events = sessionEvents[agent.name] || [];

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
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
        (isDispatcher ? " dispatcher" : "") +
        (isWorking ? " working" : "") +
        (isSelected ? " selected" : "") +
        (isArchived ? " archived" : "") +
        (isDead ? " dead" : "") +
        (mobile ? " mobile-card" : "")
      }
      style={{
        ...(placement ? { left: placement.x, top: placement.y, width: placement.w, height: placement.h } : {}),
        "--accent": accent,
        "--status-color": meta.color,
        "--card-font-size": `${fontSize}px`,
      } as React.CSSProperties}
      onMouseDown={() => { selectAgent(agent.name); setActiveAgent(agent.name); }}
    >
      {/* Header with Thronglet */}
      <div className="card-head">
        <div className="thronglet-avatar">
          <PixelThronglet spec={thronglet} mood={mood} size={48} />
        </div>
        <div className="head-text">
          <div className="session-name">
            <span className="name-text">{isDispatcher ? "Orix" : agent.name}</span>
            {isDispatcher && <span className="dispatcher-badge">DISPATCH</span>}
            {agent.title && !editingTitle && (
              <span className="agent-title" onClick={(e) => { e.stopPropagation(); setTitleDraft(agent.title || ""); setEditingTitle(true); }}>
                {agent.title}
              </span>
            )}
            {!agent.title && !isDispatcher && !editingTitle && (
              <button className="title-add-btn" onClick={(e) => { e.stopPropagation(); setTitleDraft(""); setEditingTitle(true); }} title="Add title">
                <Icon name="pencil" size={10} />
              </button>
            )}
          </div>
          {editingTitle && (
            <div className="title-edit" onClick={(e) => e.stopPropagation()}>
              <input
                className="title-input"
                placeholder="e.g. QA master"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") { setAgentTitle(agent.name, titleDraft.trim()); setEditingTitle(false); }
                  if (e.key === "Escape") setEditingTitle(false);
                }}
              />
              <button className="ico-btn" onClick={() => { setAgentTitle(agent.name, titleDraft.trim()); setEditingTitle(false); }}><Icon name="check" size={12} /></button>
              <button className="ico-btn" onClick={() => setEditingTitle(false)}><Icon name="x" size={12} /></button>
            </div>
          )}
          <div className="session-codename">{agent.runtime} · {agent.model}</div>
          {!isDispatcher && agent.sessionName && <span className="session-tag">「{agent.sessionName}」</span>}
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
          <span className="archived-badge">💀 ARCHIVED</span>
        ) : (
          <span className={"status-chip" + (isWorking ? " working" : "") + (isDead ? " dead" : "")}>
            <span className="sdot"></span>
            {meta.label}
          </span>
        )}
        <span className="inferred-text">{agent.inferred || agent.workspacePath || `${agent.messageCount} msgs`}</span>
      </div>

      {/* Conversation */}
      <div className="conversation-area" ref={scrollRef}>
        {events.length > 0 ? (
          events.map((ev, i) => (
            <MessageBubble key={i} event={ev} accent={accent} isDispatcher={isDispatcher} />
          ))
        ) : (
          <div className="conversation-empty">
            {isArchived ? "This throng's memories are archived…" : isDead ? "This throng has passed on… 🪦" : "Waiting for first interaction… 🥚"}
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

      {!mobile && <div className="resize-handle br"></div>}

      {/* Session picker dropdown */}
      {showSessionPicker && (
        <div className="session-dropdown" onMouseDown={(e) => e.stopPropagation()}>
          <div className="session-dropdown-head">Lives of {agent.name}</div>
          <button
            className={"session-dropdown-item" + ((!viewedSessionId || viewedSessionId === agent.currentSessionId) ? " active" : "")}
            onClick={() => handleSessionSwitch(agent.currentSessionId)}
          >
            <span className="session-dropdown-id">{agent.currentSessionId}</span>
            <span className="session-dropdown-badge">current life</span>
          </button>
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
            <div style={{ padding: "6px 8px", fontSize: "10.5px", color: "var(--t-4)" }}>No past lives</div>
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

function parseSender(text: string): { sender: string | null; body: string } {
  const m = text.match(/^\[from:(\w+)\]\s*/);
  if (m) return { sender: m[1], body: text.slice(m[0].length) };
  return { sender: null, body: text };
}

function MessageBubble({ event, accent, isDispatcher }: { event: SessionEvent; accent: string; isDispatcher?: boolean }) {
  const isUser = event.type === "user_message";
  const isError = event.type === "error";
  const rawText = event.text || event.error || "";

  if (!rawText) return null;

  const { sender, body } = isUser ? parseSender(rawText) : { sender: null, body: rawText };
  const isFromAgent = isUser && sender !== null;
  const displayName = isFromAgent
    ? (sender === "_dispatcher" ? "Orix" : sender)
    : isUser ? "you" : isError ? "error" : isDispatcher ? "Orix" : "throng";
  const labelIcon = isFromAgent ? "◆" : isUser ? "▶" : isError ? "✕" : "◀";

  return (
    <div className={`msg-row ${isUser ? "msg-user" : "msg-agent"}${isError ? " msg-error" : ""}${isFromAgent ? " msg-peer" : ""}`}>
      <div className="msg-label">{labelIcon} {displayName}</div>
      <div className="msg-body">
        {isUser ? body : renderMarkdown(body)}
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
