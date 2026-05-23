import { useState, useRef, useEffect, useMemo } from "react";
import { useFleetStore, sendMessage, killAgent, clearAgent, spawnAgent } from "../stores/fleet";
import { Icon } from "./Icons";

interface Command {
  id: string;
  label: string;
  detail?: string;
  icon: string;
  action: () => void;
  keywords?: string;
}

export function CommandBar() {
  const {
    agents, workspaces, commandBarOpen, setCommandBarOpen,
    setSpawnDialogOpen, setActiveAgent, setTheme, theme,
    setCols, cols, toggleDispatcher,
  } = useFleetStore();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (commandBarOpen) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandBarOpen]);

  const commands = useMemo(() => {
    const cmds: Command[] = [];

    cmds.push({
      id: "spawn",
      label: "Hatch new Thronglet",
      detail: "Ctrl+N",
      icon: "plus",
      action: () => { setCommandBarOpen(false); setSpawnDialogOpen(true); },
      keywords: "new create add agent spawn hatch thronglet",
    });

    for (const a of agents) {
      cmds.push({
        id: `send-${a.name}`,
        label: `Send to @${a.name}`,
        detail: `${a.runtime} · ${a.workspace}`,
        icon: "send",
        action: () => { setActiveAgent(a.name); setCommandBarOpen(false); },
        keywords: `send message ${a.name} ${a.runtime}`,
      });

      cmds.push({
        id: `kill-${a.name}`,
        label: `Kill @${a.name}`,
        detail: `stop ${a.runtime} agent`,
        icon: "stop",
        action: () => { killAgent(a.name); setCommandBarOpen(false); },
        keywords: `kill stop terminate ${a.name}`,
      });

      cmds.push({
        id: `clear-${a.name}`,
        label: `Clear @${a.name} session`,
        detail: "start fresh conversation",
        icon: "trash",
        action: () => { clearAgent(a.name); setCommandBarOpen(false); },
        keywords: `clear reset ${a.name}`,
      });
    }

    cmds.push({
      id: "broadcast",
      label: "Broadcast to @all",
      detail: "send to every agent",
      icon: "send",
      action: () => { setActiveAgent("@all"); setCommandBarOpen(false); },
      keywords: "broadcast all send everyone",
    });

    cmds.push({
      id: "toggle-theme",
      label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
      icon: "settings",
      action: () => { setTheme(theme === "dark" ? "light" : "dark"); setCommandBarOpen(false); },
      keywords: "theme dark light mode toggle",
    });

    cmds.push({
      id: "add-col",
      label: `Increase columns (${cols} → ${Math.min(5, cols + 1)})`,
      icon: "plus",
      action: () => { setCols(cols + 1); setCommandBarOpen(false); },
      keywords: "columns grid layout wider",
    });

    cmds.push({
      id: "rm-col",
      label: `Decrease columns (${cols} → ${Math.max(2, cols - 1)})`,
      icon: "x",
      action: () => { setCols(cols - 1); setCommandBarOpen(false); },
      keywords: "columns grid layout narrow",
    });

    cmds.push({
      id: "toggle-dispatcher",
      label: "Toggle habitat panel",
      icon: "dispatch",
      action: () => { toggleDispatcher(); setCommandBarOpen(false); },
      keywords: "dispatcher habitat panel toggle show hide",
    });

    return cmds;
  }, [agents, workspaces, theme, cols]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      (c.detail || "").toLowerCase().includes(q) ||
      (c.keywords || "").toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && filtered[selected]) {
      e.preventDefault();
      filtered[selected].action();
    } else if (e.key === "Escape") {
      setCommandBarOpen(false);
    }
  };

  if (!commandBarOpen) return null;

  return (
    <div className="cmdbar-overlay" onMouseDown={() => setCommandBarOpen(false)}>
      <div className="cmdbar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdbar-input-wrap">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="cmdbar-input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="cmdbar-esc">Esc</kbd>
        </div>
        <div className="cmdbar-list">
          {filtered.length === 0 && (
            <div className="cmdbar-empty">No matching commands</div>
          )}
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              className={"cmdbar-item" + (i === selected ? " selected" : "")}
              onClick={cmd.action}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="cmdbar-ico"><Icon name={cmd.icon} size={13} /></span>
              <span className="cmdbar-label">{cmd.label}</span>
              {cmd.detail && <span className="cmdbar-detail">{cmd.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
