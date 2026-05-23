import { useState, useRef, useEffect } from "react";
import { useFleetStore, sendMessage } from "../stores/fleet";
import { getAgentGlyph, STATUS_META, getAgentColor } from "../lib/constants";
import { Icon } from "./Icons";

export function ChatBar() {
  const {
    agents, activeAgent, setActiveAgent, selectedAgent,
  } = useFleetStore();

  const [text, setText] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !activeAgent || sending) return;

    setSending(true);
    setText("");

    if (activeAgent === "@all") {
      for (const a of agents) {
        sendMessage(a.name, trimmed);
      }
    } else if (activeAgent === "dispatch") {
      const dispatcher = agents.find((a) => a.name === "_dispatcher");
      if (dispatcher) {
        sendMessage("_dispatcher", trimmed);
      } else {
        sendMessage(agents[0]?.name || "", trimmed);
      }
    } else {
      sendMessage(activeAgent, trimmed);
    }

    setSending(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
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
              {agents.map((a) => {
                const meta = STATUS_META[a.status] || STATUS_META.idle;
                return (
                  <button
                    key={a.name}
                    className={"asd-item" + (activeAgent === a.name ? " active" : "")}
                    onClick={() => { setActiveAgent(a.name); setSelectorOpen(false); inputRef.current?.focus(); }}
                  >
                    <span className="asd-glyph" style={{ background: getAgentColor(a.runtime) }}>{getAgentGlyph(a.runtime)}</span>
                    <span className="asd-name">@{a.name}</span>
                    <span className="asd-detail">{a.sessionName ? `「${a.sessionName}」` : `${a.runtime} · ${a.workspace}`}</span>
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
        <input
          ref={inputRef}
          className="chatbar-input"
          placeholder={
            isWorking
              ? `${activeAgent} is working…`
              : activeAgent
                ? `Message @${activeAgent}…`
                : "Select an agent first…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!activeAgent}
        />

        {/* Keyboard hint */}
        <div className="chatbar-hints">
          <kbd>⌘K</kbd>
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
