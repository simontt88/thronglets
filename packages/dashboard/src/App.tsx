import { useEffect } from "react";
import { useFleetStore, connectWS } from "./stores/fleet";
import { TopBar } from "./components/TopBar";
import { GridStage } from "./components/GridStage";
import { ChatBar } from "./components/ChatBar";
import { CommandBar } from "./components/CommandBar";
import { SpawnDialog } from "./components/SpawnDialog";
import { useKeyboard } from "./lib/useKeyboard";

export function App() {
  const { connected } = useFleetStore();

  useEffect(() => {
    connectWS();
  }, []);

  useKeyboard();

  return (
    <>
      <div className="aurora"></div>
      <div className="app">
        <TopBar />
        <GridStage />
        <ChatBar />
      </div>
      <CommandBar />
      <SpawnDialog />
    </>
  );
}
