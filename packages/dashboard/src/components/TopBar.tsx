import { useFleetStore } from "../stores/fleet";
import { Icon } from "./Icons";

export function TopBar() {
  const { agents, workspaces, currentWorkspace, setWorkspace, dispatcherOpen, toggleDispatcher, theme, setTheme } = useFleetStore();

  const wsGroups = [
    { alias: "all", name: "All", path: "", count: agents.length },
    ...workspaces.map((ws) => ({
      alias: ws.alias,
      name: ws.alias,
      path: ws.path,
      count: agents.filter((a) => a.workspace === ws.alias).length,
    })),
  ];

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"></div>
        <div className="brand-name">kenyalang<span className="dim">fleet</span></div>
      </div>

      <nav className="workspaces">
        {wsGroups.map((ws) => (
          <button
            key={ws.alias}
            className={"ws-tab" + (currentWorkspace === ws.alias ? " active" : "")}
            onClick={() => setWorkspace(ws.alias)}
            title={ws.path || ws.name}
          >
            <span className="ws-dot" style={{ background: ws.alias === "all" ? "var(--t-3)" : undefined }}></span>
            <span>{ws.name}</span>
            <span className="ws-count">{ws.count}</span>
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        <div className="search">
          <Icon name="search" size={13} />
          <span>Search agents…</span>
        </div>
        <button
          className={"icon-btn" + (dispatcherOpen ? " on" : "")}
          title="Toggle dispatcher"
          onClick={toggleDispatcher}
        >
          <Icon name="panel" size={14} />
        </button>
        <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <Icon name="settings" size={14} />
        </button>
      </div>
    </header>
  );
}
