import { useState } from "react";
import { useFleetStore, addWorkspace, deleteWorkspace } from "../stores/fleet";
import { Icon } from "./Icons";

export function WorkspaceHeader() {
  const { agents, workspaces, currentWorkspace, cols, setCols, setSpawnDialogOpen, setWorkspace } = useFleetStore();
  const [showAddWs, setShowAddWs] = useState(false);
  const [wsAlias, setWsAlias] = useState("");
  const [wsPath, setWsPath] = useState("");

  const filtered = currentWorkspace === "all" ? agents : agents.filter((a) => a.workspace === currentWorkspace);
  const working = filtered.filter((a) => a.status === "working").length;
  const errors = filtered.filter((a) => a.status === "error").length;
  const idle = filtered.filter((a) => a.status === "idle").length;
  const dead = filtered.filter((a) => a.status === "stopped").length;

  const title = currentWorkspace === "all" ? "All Thronglets" : currentWorkspace;
  const wsEntry = workspaces.find((w) => w.alias === currentWorkspace);
  const wsPath_ = wsEntry?.path || "";

  const handleAddWs = async () => {
    if (!wsAlias.trim() || !wsPath.trim()) return;
    await addWorkspace(wsAlias.trim(), wsPath.trim());
    setWsAlias("");
    setWsPath("");
    setShowAddWs(false);
  };

  const handleDeleteWs = async () => {
    if (currentWorkspace === "all") return;
    if (!confirm(`Remove workspace "${currentWorkspace}"?`)) return;
    await deleteWorkspace(currentWorkspace);
    setWorkspace("all");
  };

  return (
    <div className="ws-header">
      <div className="h-block">
        <div className="crumb">
          <span>habitat</span>
          <span className="sep">/</span>
          <span>{title.toUpperCase()}</span>
        </div>
        <div className="h-title">
          {title}
          <span className="h-sub">{filtered.length} thronglet{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        {wsPath_ && <div className="h-path">{wsPath_}</div>}
      </div>
      <div className="h-stats">
        <span><span className="v">{filtered.length}</span>total</span>
        <span><span className="v">{working}</span>grinding</span>
        <span><span className="v">{errors}</span>sad</span>
        <span><span className="v">{idle}</span>vibing</span>
        {dead > 0 && <span><span className="v">{dead}</span>dead</span>}
      </div>
      <div className="stage-toolbar">
        <div className="tb-group">
          <button className="tb-btn" onClick={() => setCols(cols - 1)}>-</button>
          <span className="tb-cols">columns<span className="num">{cols}</span></span>
          <button className="tb-btn" onClick={() => setCols(cols + 1)}>+</button>
        </div>
        <div className="tb-group">
          <button className="tb-btn primary" onClick={() => setSpawnDialogOpen(true)}>
            <Icon name="plus" size={12} />
            <span>Hatch</span>
          </button>
        </div>
        <div className="tb-group">
          <button className="tb-btn" onClick={() => setShowAddWs(true)}>
            <Icon name="plus" size={12} />
            <span>Workspace</span>
          </button>
          {currentWorkspace !== "all" && (
            <button className="tb-btn danger" onClick={handleDeleteWs} title={`Remove workspace "${currentWorkspace}"`}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      </div>

      {showAddWs && (
        <div className="ws-add-form">
          <input
            className="ws-add-input"
            placeholder="alias (e.g. my-project)"
            value={wsAlias}
            onChange={(e) => setWsAlias(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleAddWs()}
          />
          <input
            className="ws-add-input"
            placeholder="/path/to/workspace"
            value={wsPath}
            onChange={(e) => setWsPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddWs()}
          />
          <button className="tb-btn primary" onClick={handleAddWs}>Add</button>
          <button className="tb-btn" onClick={() => setShowAddWs(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
