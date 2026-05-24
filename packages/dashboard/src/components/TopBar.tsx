import { useState, useRef, useEffect } from "react";
import { useFleetStore, deleteWorkspace, renameWorkspace } from "../stores/fleet";
import { Icon } from "./Icons";
import { PixelThronglet } from "./PixelThronglet";
import { generateThronglet } from "../lib/thronglet";

export function TopBar() {
  const { agents, workspaces, currentWorkspace, setWorkspace, theme, setTheme, toggleDispatcher, mode, setMode } = useFleetStore();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [editingWs, setEditingWs] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingWs && editRef.current) editRef.current.focus();
  }, [editingWs]);

  const wsGroups = [
    { alias: "all", name: "All", path: "", count: agents.length },
    ...workspaces.map((ws) => ({
      alias: ws.alias,
      name: ws.alias,
      path: ws.path,
      count: agents.filter((a) => a.workspace === ws.alias).length,
    })),
  ];

  const handleDeleteWs = async (alias: string) => {
    const result = await deleteWorkspace(alias);
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    setConfirmDelete(null);
    setDeleteError("");
    if (currentWorkspace === alias) setWorkspace("all");
  };

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <PixelThronglet spec={generateThronglet("thronglets")} mood="happy" size={28} />
        </div>
        <div className="brand-name">Thronglets</div>
      </div>

      <nav className="workspaces">
        {wsGroups.map((ws) => (
          <button
            key={ws.alias}
            className={"ws-tab" + (currentWorkspace === ws.alias ? " active" : "")}
            onClick={() => setWorkspace(ws.alias)}
            onDoubleClick={() => {
              if (ws.alias !== "all" && ws.alias !== "dispatch") {
                setEditingWs(ws.alias);
                setEditValue(ws.alias);
              }
            }}
            title={ws.path ? `${ws.path} (double-click to rename)` : ws.name}
          >
            <span className="ws-dot" style={{ background: ws.alias === "all" ? "var(--t-3)" : undefined }}></span>
            {editingWs === ws.alias ? (
              <input
                ref={editRef}
                className="ws-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={async (e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    const trimmed = editValue.trim();
                    if (trimmed && trimmed !== ws.alias) {
                      await renameWorkspace(ws.alias, trimmed);
                    }
                    setEditingWs(null);
                  } else if (e.key === "Escape") {
                    setEditingWs(null);
                  }
                }}
                onBlur={() => setEditingWs(null)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span>{ws.name}</span>
            )}
            <span className="ws-count">{ws.count}</span>
            {ws.alias !== "all" && ws.alias !== "dispatch" && (
              <span
                className="ws-delete"
                title={`Remove ${ws.alias}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteError("");
                  setConfirmDelete(ws.alias);
                }}
              >×</span>
            )}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <button
          className={"icon-btn mode-toggle" + (mode === "chill" ? " active" : "")}
          title={mode === "work" ? "Switch to Chill mode (Ctrl+.)" : "Switch to Work mode (Ctrl+.)"}
          onClick={() => setMode(mode === "work" ? "chill" : "work")}
        >
          {mode === "work" ? "🎮" : "💼"}
        </button>
        <button className="icon-btn" title="Fleet status panel" onClick={() => toggleDispatcher()}>
          <Icon name="dispatch" size={14} />
        </button>
        <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <Icon name="settings" size={14} />
        </button>
      </div>

      {confirmDelete && (
        <div className="ws-confirm-overlay" onClick={() => { setConfirmDelete(null); setDeleteError(""); }}>
          <div className="ws-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="ws-confirm-title">Remove workspace "{confirmDelete}"?</div>
            {deleteError && <div className="ws-confirm-error">{deleteError}</div>}
            <div className="ws-confirm-actions">
              <button className="tb-btn" onClick={() => { setConfirmDelete(null); setDeleteError(""); }}>Cancel</button>
              <button className="tb-btn danger" onClick={() => handleDeleteWs(confirmDelete)}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
