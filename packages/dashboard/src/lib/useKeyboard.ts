import { useEffect } from "react";
import { useFleetStore } from "../stores/fleet";

export function useKeyboard() {
  const {
    setCommandBarOpen, commandBarOpen,
    setSpawnDialogOpen, spawnDialogOpen,
    agents, activeAgent, setActiveAgent,
    mode, setMode,
  } = useFleetStore();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA";

      // Ctrl/Cmd+. → toggle work/chill mode
      if (meta && e.key === ".") {
        e.preventDefault();
        setMode(mode === "work" ? "chill" : "work");
        return;
      }

      // Cmd/Ctrl+K → command bar
      if (meta && e.key === "k") {
        e.preventDefault();
        setCommandBarOpen(!commandBarOpen);
        return;
      }

      // Cmd/Ctrl+N → spawn dialog (only if not in an input)
      if (meta && e.key === "n" && !isInput) {
        e.preventDefault();
        setSpawnDialogOpen(!spawnDialogOpen);
        return;
      }

      // Escape → close overlays
      if (e.key === "Escape") {
        if (commandBarOpen) { setCommandBarOpen(false); return; }
        if (spawnDialogOpen) { setSpawnDialogOpen(false); return; }
      }

      // / → focus chatbar (if not in an input)
      if (e.key === "/" && !isInput && !commandBarOpen && !spawnDialogOpen) {
        e.preventDefault();
        const chatInput = document.querySelector(".chatbar-input") as HTMLInputElement;
        chatInput?.focus();
        return;
      }

      // Tab through agents (when not in input and no overlay open)
      if (e.key === "Tab" && !isInput && !commandBarOpen && !spawnDialogOpen && agents.length > 0) {
        e.preventDefault();
        const names = agents.map((a) => a.name);
        const idx = names.indexOf(activeAgent);
        const next = e.shiftKey
          ? (idx <= 0 ? names.length - 1 : idx - 1)
          : (idx < 0 ? 0 : (idx + 1) % names.length);
        setActiveAgent(names[next]);
        return;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [commandBarOpen, spawnDialogOpen, agents, activeAgent, mode]);
}
