import { useEffect } from "react";
import { useFleetStore, connectWS } from "./stores/fleet";
import { TopBar } from "./components/TopBar";
import { GridStage } from "./components/GridStage";
import { ChatBar } from "./components/ChatBar";
import { CommandBar } from "./components/CommandBar";
import { SpawnDialog } from "./components/SpawnDialog";
import { ChillMode } from "./components/ChillMode";
import { useKeyboard } from "./lib/useKeyboard";

export function App() {
  const { connected, mode } = useFleetStore();

  useEffect(() => {
    connectWS();
  }, []);

  useKeyboard();

  return (
    <>
      <div className="aurora"></div>
      <div className="app">
        <TopBar />
        {mode === "work" ? (
          <>
            <GridStage />
            <ChatBar />
          </>
        ) : (
          <ChillMode />
        )}
      </div>
      <CommandBar />
      <SpawnDialog />
    </>
  );
}
