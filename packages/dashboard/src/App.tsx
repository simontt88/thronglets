import { useEffect } from "react";
import { useFleetStore, connectWS } from "./stores/fleet";
import { FleetPanel } from "./components/FleetPanel";
import { SessionView } from "./components/SessionView";

export function App() {
  const { connected, selectedAgent } = useFleetStore();

  useEffect(() => {
    connectWS();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header style={{
        padding: "12px 24px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}>
        <h1 style={{ fontSize: "1.1rem", fontWeight: 600 }}>Agent Bridge</h1>
        <span style={{
          fontSize: "0.75rem",
          padding: "2px 8px",
          borderRadius: "4px",
          background: connected ? "var(--green)" : "var(--red)",
          color: "#fff",
        }}>
          {connected ? "LIVE" : "OFFLINE"}
        </span>
      </header>

      <main style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <FleetPanel />
        {selectedAgent && <SessionView />}
      </main>
    </div>
  );
}
