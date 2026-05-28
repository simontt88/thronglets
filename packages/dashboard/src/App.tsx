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

function useVisualViewportResize() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const offset = window.innerHeight - vv.height;
      document.documentElement.style.setProperty("--kb-offset", `${offset}px`);
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
      document.documentElement.style.removeProperty("--kb-offset");
    };
  }, []);
}

export function App() {
  const { connected, mode } = useFleetStore();
  const isMobile = useMobileBreakpoint();

  useEffect(() => {
    connectWS();
  }, []);

  useKeyboard();
  useVisualViewportResize();

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
