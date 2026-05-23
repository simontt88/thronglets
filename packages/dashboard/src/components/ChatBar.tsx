import { useState, useRef, useEffect } from "react";
import { useFleetStore, sendMessage } from "../stores/fleet";
import { STATUS_META, getAgentColor } from "../lib/constants";
import { PixelThronglet } from "./PixelThronglet";
import { generateThronglet, statusToMood } from "../lib/thronglet";
import { Icon } from "./Icons";

export function ChatBar() {
  const {
    agents, activeAgent, setActiveAgent, selectedAgent,
  } = useFleetStore();

  const [text, setText] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeAgent && agents.length === 1) {
      setActiveAgent(agents[0].name);
    }
  }, [agents.length]);

  useEffect(() => {
    if (selectedAgent && selectedAgent !== activeAgent) {
      setActiveAgent(selectedAgent);
    }
  }, [selectedAgent]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
      }
    }
    if (selectorOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [selectorOpen]);

  const DISPATCHER_ALIASES = new Set(["D", "d", "dispatch", "dispatcher", "orix"]);

  const resolveTarget = (target: string, body: string): { resolved: string; finalBody: string } => {
    if (target === "@all" || target === "dispatch" || target === "_dispatcher") {
      return { resolved: target, finalBody: body };
    }
    // Check for @D style inline mentions at start of message
    const mentionMatch = body.match(/^@(\w+)\s*/);
    if (mentionMatch && DISPATCHER_ALIASES.has(mentionMatch[1])) {
      return { resolved: "dispatch", finalBody: body.slice(mentionMatch[0].length).trim() || body };
    }
    return { resolved: target, finalBody: body };
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !activeAgent || sending) return;

    setSending(true);
    setText("");

    const { resolved, finalBody } = resolveTarget(activeAgent, trimmed);

    if (resolved === "@all") {
      for (const a of agents) {
        sendMessage(a.name, finalBody);
      }
    } else if (resolved === "dispatch" || resolved === "_dispatcher") {
      const dispatcher = agents.find((a) => a.name === "_dispatcher");
      if (dispatcher) {
        sendMessage("_dispatcher", finalBody);
      } else {
        console.warn("[chatbar] _dispatcher not found, message not sent");
        setText(trimmed);
        setSending(false);
        return;
      }
    } else {
      sendMessage(resolved, finalBody);
    }

    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const agentForDisplay = agents.find((a) => a.name === activeAgent);
  const isWorking = agentForDisplay?.status === "working";

  return (
    <div className="chatbar">
      <div className="chatbar-inner">
        {/* Agent selector */}
        <div className="agent-selector-wrap" ref={selectorRef}>
          <button
            className={"agent-selector-btn" + (selectorOpen ? " open" : "")}
            onClick={() => setSelectorOpen(!selectorOpen)}
          >
            {activeAgent === "@all" ? (
              <span className="as-label">@all</span>
            ) : activeAgent === "dispatch" ? (
              <>
                <Icon name="dispatch" size={12} />
                <span className="as-label">dispatch</span>
              </>
            ) : agentForDisplay ? (
              <>
                <span className="as-dot" style={{ background: getAgentColor(agentForDisplay.runtime) }} />
                <span className="as-label">@{agentForDisplay.name}</span>
              </>
            ) : (
              <span className="as-label as-placeholder">select agent</span>
            )}
            <span className="as-caret">▾</span>
          </button>

          {selectorOpen && (
            <div className="agent-selector-dropdown">
              <div className="asd-head">Send to</div>
              {agents.filter((a) => a.name !== "_dispatcher").map((a) => {
                const meta = STATUS_META[a.status] || STATUS_META.waiting;
                return (
                  <button
                    key={a.name}
                    className={"asd-item" + (activeAgent === a.name ? " active" : "")}
                    onClick={() => { setActiveAgent(a.name); setSelectorOpen(false); inputRef.current?.focus(); }}
                  >
                    <span className="asd-glyph" style={{ background: "transparent", padding: 0 }}>
                      <PixelThronglet spec={generateThronglet(a.name)} mood={statusToMood(a.status, a.lastActivity)} size={28} />
                    </span>
                    <span className="asd-name">@{a.name}</span>
                    <span className="asd-detail">{a.runtime} · {a.workspace}</span>
                    <span className="asd-status-dot" style={{ background: meta.color }} />
                  </button>
                );
              })}
              <div className="asd-divider" />
              <button
                className={"asd-item" + (activeAgent === "@all" ? " active" : "")}
                onClick={() => { setActiveAgent("@all"); setSelectorOpen(false); inputRef.current?.focus(); }}
              >
                <span className="asd-glyph broadcast">all</span>
                <span className="asd-name">@all</span>
                <span className="asd-detail">broadcast to all agents</span>
              </button>
              <button
                className={"asd-item" + (activeAgent === "dispatch" ? " active" : "")}
                onClick={() => { setActiveAgent("dispatch"); setSelectorOpen(false); inputRef.current?.focus(); }}
              >
                <span className="asd-glyph dispatch-glyph"><Icon name="sparkle" size={11} /></span>
                <span className="asd-name">dispatch</span>
                <span className="asd-detail">AI routes to best agent</span>
              </button>
            </div>
          )}
        </div>

        {/* Input */}
        <textarea
          ref={inputRef}
          className="chatbar-input"
          rows={1}
          placeholder={
            isWorking
              ? `${activeAgent} is grinding…`
              : activeAgent
                ? `Talk to @${activeAgent}… (Shift+Enter to send)`
                : "Pick a Thronglet first…"
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 120) + "px";
          }}
          onKeyDown={handleKeyDown}
          disabled={!activeAgent}
        />

        {/* Keyboard hint */}
        <div className="chatbar-hints">
          <kbd>⇧↵</kbd>
        </div>

        {/* Send */}
        <button
          className={"chatbar-send" + (text.trim() && activeAgent ? " ready" : "")}
          onClick={handleSend}
          disabled={!text.trim() || !activeAgent || sending}
        >
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  );
}
