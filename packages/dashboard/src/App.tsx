import { useEffect, useSyncExternalStore } from "react";
import { useFleetStore, connectWS } from "./stores/fleet";
import { TopBar } from "./components/TopBar";
import { GridStage } from "./components/GridStage";
import { MobileStage } from "./components/MobileStage";
import { MobileDispatcher } from "./components/MobileDispatcher";
import { ChatBar } from "./components/ChatBar";
import { CommandBar } from "./components/CommandBar";
import { SpawnDialog } from "./components/SpawnDialog";
import { ChillMode } from "./components/ChillMode";
import { useKeyboard } from "./lib/useKeyboard";

const mobileQuery = typeof window !== "undefined" ? window.matchMedia("(max-width: 768px)") : null;

function useMobileBreakpoint(): boolean {
  return useSyncExternalStore(
    (cb) => {
      mobileQuery?.addEventListener("change", cb);
      return () => mobileQuery?.removeEventListener("change", cb);
    },
    () => mobileQuery?.matches ?? false,
  );
}

export function App() {
  const { connected, mode } = useFleetStore();
  const isMobile = useMobileBreakpoint();

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
            {isMobile ? <MobileStage /> : <GridStage />}
            <ChatBar />
          </>
        ) : (
          <ChillMode />
        )}
      </div>
      {isMobile && <MobileDispatcher />}
      <CommandBar />
      <SpawnDialog />
    </>
  );
}
