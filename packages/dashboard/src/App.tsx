import { useEffect } from "react";
import { useFleetStore, connectWS } from "./stores/fleet";
import { TopBar } from "./components/TopBar";
import { GridStage } from "./components/GridStage";

export function App() {
  const { connected } = useFleetStore();

  useEffect(() => {
    connectWS();
  }, []);

  return (
    <>
      <div className="aurora"></div>
      <div className="app">
        <TopBar />
        <GridStage />
      </div>
    </>
  );
}
