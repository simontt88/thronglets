import { useFleetStore } from "../stores/fleet";
import { Icon } from "./Icons";

export function WorkspaceHeader() {
  const { agents, workspaces, currentWorkspace, cols, setCols, toggleDispatcher, dispatcherOpen, setSpawnDialogOpen } = useFleetStore();

  const filtered = currentWorkspace === "all" ? agents : agents.filter((a) => a.workspace === currentWorkspace);
  const working = filtered.filter((a) => a.status === "working").length;
  const errors = filtered.filter((a) => a.status === "error").length;
  const idle = filtered.filter((a) => a.status === "idle").length;

  const title = currentWorkspace === "all" ? "All Agents" : currentWorkspace;
  const wsEntry = workspaces.find((w) => w.alias === currentWorkspace);
  const wsPath = wsEntry?.path || (currentWorkspace === "all" ? "" : "");

  return (
    <div className="ws-header">
      <div className="h-block">
        <div className="crumb">
          <span>workspace</span>
          <span className="sep">/</span>
          <span>{title.toUpperCase()}</span>
        </div>
        <div className="h-title">
          {title}
          <span className="h-sub">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</span>
        </div>
        {wsPath && <div className="h-path">{wsPath}</div>}
      </div>
      <div className="h-stats">
        <span><span className="v">{filtered.length}</span>total</span>
        <span><span className="v">{working}</span>working</span>
        <span><span className="v">{errors}</span>errors</span>
        <span><span className="v">{idle}</span>idle</span>
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
            <span>Spawn</span>
          </button>
        </div>
        <div className="tb-group">
          <button className={"tb-btn" + (dispatcherOpen ? " primary" : "")} onClick={toggleDispatcher}>
            <Icon name="dispatch" size={12} />
            <span>Dispatcher</span>
          </button>
        </div>
      </div>
    </div>
  );
}
