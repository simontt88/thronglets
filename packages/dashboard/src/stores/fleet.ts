import { create } from "zustand";
import { getAgentColor } from "../lib/constants";

export interface AgentState {
  name: string;
  runtime: string;
  model: string;
  workspace: string;
  workspacePath: string;
  status: "idle" | "working" | "error" | "stopped";
  currentSessionId: string;
  spawnedAt: string;
  lastActivity: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAgentMessage?: string;
  inferred?: string;
}

export interface SessionEvent {
  ts: string;
  type: string;
  text?: string;
  error?: string;
}

export interface WorkspaceEntry {
  alias: string;
  path: string;
}

interface CardSize {
  colSpan: number;
  height: number;
}

interface FleetStore {
  agents: AgentState[];
  workspaces: WorkspaceEntry[];
  connected: boolean;
  theme: "light" | "dark";

  // UI state
  currentWorkspace: string; // "all" or workspace alias
  cols: number;
  dispatcherOpen: boolean;
  selectedAgent: string | null;

  // Per-card session viewing
  viewingSession: Record<string, string>; // agentName → sessionId being viewed
  sessionLists: Record<string, string[]>; // agentName → list of all session IDs
  sessionEvents: Record<string, SessionEvent[]>; // agentName → events for viewed session

  // Card sizes (persisted to localStorage)
  cardSizes: Record<string, CardSize>;

  // Color overrides
  colorOverrides: Record<string, string>;

  // Per-card font size
  fontSizes: Record<string, number>; // agentName → px
  setFontSize: (name: string, size: number) => void;

  // Actions
  setConnected: (v: boolean) => void;
  setTheme: (t: "light" | "dark") => void;
  setWorkspace: (ws: string) => void;
  setCols: (n: number) => void;
  toggleDispatcher: () => void;
  selectAgent: (name: string | null) => void;
  setCardSize: (name: string, size: CardSize) => void;
  setColorOverride: (name: string, color: string) => void;
  setViewingSession: (agent: string, sessionId: string) => void;
  clearViewingSession: (agent: string) => void;
}

const savedSizes = JSON.parse(localStorage.getItem("ab-card-sizes") || "{}");
const savedColors = JSON.parse(localStorage.getItem("ab-color-overrides") || "{}");
const savedFontSizes = JSON.parse(localStorage.getItem("ab-font-sizes") || "{}");
const savedTheme = (localStorage.getItem("ab-theme") || "light") as "light" | "dark";

export const useFleetStore = create<FleetStore>((set, get) => ({
  agents: [],
  workspaces: [],
  connected: false,
  theme: savedTheme,
  currentWorkspace: "all",
  cols: 3,
  dispatcherOpen: true,
  selectedAgent: null,
  viewingSession: {},
  sessionLists: {},
  sessionEvents: {},
  cardSizes: savedSizes,
  colorOverrides: savedColors,
  fontSizes: savedFontSizes,

  setConnected: (connected) => set({ connected }),
  setTheme: (theme) => {
    localStorage.setItem("ab-theme", theme);
    document.body.className = theme === "dark" ? "theme-dark" : "";
    set({ theme });
  },
  setWorkspace: (ws) => set({ currentWorkspace: ws }),
  setCols: (cols) => set({ cols: Math.max(2, Math.min(5, cols)) }),
  toggleDispatcher: () => set((s) => ({ dispatcherOpen: !s.dispatcherOpen })),
  selectAgent: (name) => set({ selectedAgent: name }),
  setCardSize: (name, size) => {
    const cardSizes = { ...get().cardSizes, [name]: size };
    localStorage.setItem("ab-card-sizes", JSON.stringify(cardSizes));
    set({ cardSizes });
  },
  setColorOverride: (name, color) => {
    const colorOverrides = { ...get().colorOverrides, [name]: color };
    localStorage.setItem("ab-color-overrides", JSON.stringify(colorOverrides));
    set({ colorOverrides });
  },
  setFontSize: (name, size) => {
    const clamped = Math.max(10, Math.min(20, size));
    const fontSizes = { ...get().fontSizes, [name]: clamped };
    localStorage.setItem("ab-font-sizes", JSON.stringify(fontSizes));
    set({ fontSizes });
  },
  setViewingSession: (agent, sessionId) => set((s) => ({
    viewingSession: { ...s.viewingSession, [agent]: sessionId },
  })),
  clearViewingSession: (agent) => set((s) => {
    const v = { ...s.viewingSession };
    delete v[agent];
    return { viewingSession: v };
  }),
}));

// Apply theme on load
document.body.className = savedTheme === "dark" ? "theme-dark" : "";

// WebSocket connection
let ws: WebSocket | null = null;

export function connectWS() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    useFleetStore.getState().setConnected(true);
  };

  ws.onclose = () => {
    useFleetStore.getState().setConnected(false);
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws?.close();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const store = useFleetStore.getState();

    if (msg.type === "fleet_snapshot") {
      useFleetStore.setState({
        agents: msg.agents || [],
        workspaces: msg.workspaces || [],
      });
    } else if (msg.type === "event") {
      const event = msg.event;
      switch (event.type) {
        case "agent_spawned":
          fetchFleet();
          break;
        case "agent_killed":
          useFleetStore.setState((s) => ({
            agents: s.agents.filter((a) => a.name !== event.agentName),
          }));
          break;
        case "status_change":
          useFleetStore.setState((s) => ({
            agents: s.agents.map((a) =>
              a.name === event.agentName
                ? { ...a, status: event.payload?.status, lastActivity: event.ts, inferred: event.payload?.inferred }
                : a
            ),
          }));
          break;
        case "user_message":
          useFleetStore.setState((s) => ({
            agents: s.agents.map((a) =>
              a.name === event.agentName
                ? { ...a, lastUserMessage: event.payload?.text, lastActivity: event.ts }
                : a
            ),
          }));
          appendSessionEvent(event.agentName, { ts: event.ts, type: "user_message", text: event.payload?.text });
          break;
        case "agent_message":
          useFleetStore.setState((s) => ({
            agents: s.agents.map((a) =>
              a.name === event.agentName
                ? { ...a, lastAgentMessage: event.payload?.text, lastActivity: event.ts, messageCount: a.messageCount + 1 }
                : a
            ),
          }));
          appendSessionEvent(event.agentName, { ts: event.ts, type: "agent_message", text: event.payload?.text });
          break;
        case "error":
          useFleetStore.setState((s) => ({
            agents: s.agents.map((a) =>
              a.name === event.agentName
                ? { ...a, status: "error", inferred: `error: ${(event.payload?.error || "").slice(0, 60)}`, lastActivity: event.ts }
                : a
            ),
          }));
          break;
        case "session_cleared":
          useFleetStore.setState((s) => ({
            agents: s.agents.map((a) =>
              a.name === event.agentName
                ? { ...a, currentSessionId: event.payload?.newSessionId, messageCount: 0, lastUserMessage: undefined, lastAgentMessage: undefined }
                : a
            ),
            sessionEvents: { ...s.sessionEvents, [event.agentName]: [] },
          }));
          break;
      }
    }
  };
}

function appendSessionEvent(agentName: string, event: SessionEvent) {
  const store = useFleetStore.getState();
  const viewing = store.viewingSession[agentName];
  const agent = store.agents.find((a) => a.name === agentName);
  // Only append if viewing current active session (or not viewing any specific one)
  if (!viewing || viewing === agent?.currentSessionId) {
    const events = store.sessionEvents[agentName] || [];
    useFleetStore.setState({
      sessionEvents: { ...store.sessionEvents, [agentName]: [...events, event].slice(-100) },
    });
  }
}

export async function fetchFleet() {
  try {
    const res = await fetch("/api/fleet");
    const data = await res.json();
    useFleetStore.setState({ agents: data.agents || [], workspaces: data.workspaces || [] });
  } catch {}
}

export async function fetchSessionList(agentName: string) {
  try {
    const res = await fetch(`/api/agents/${agentName}/sessions`);
    const data = await res.json();
    useFleetStore.setState((s) => ({
      sessionLists: { ...s.sessionLists, [agentName]: data.sessions || [] },
    }));
  } catch {}
}

export async function fetchSessionEvents(agentName: string, sessionId: string) {
  try {
    const res = await fetch(`/api/agents/${agentName}/events?session=${sessionId}&limit=500`);
    const data = await res.json();
    useFleetStore.setState((s) => ({
      sessionEvents: { ...s.sessionEvents, [agentName]: data.events || [] },
    }));
  } catch {}
}

export async function sendMessage(agentName: string, text: string) {
  try {
    await fetch(`/api/agents/${agentName}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {}
}

export function getAgentAccent(agent: AgentState): string {
  const overrides = useFleetStore.getState().colorOverrides;
  return overrides[agent.name] || getAgentColor(agent.runtime);
}
