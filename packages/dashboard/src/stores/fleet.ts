import { create } from "zustand";

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
}

export interface SessionEvent {
  ts: string;
  type: string;
  text?: string;
  error?: string;
}

interface FleetStore {
  agents: AgentState[];
  workspaces: { alias: string; path: string }[];
  runtimes: { name: string; runtime: string; model: string }[];
  connected: boolean;
  selectedAgent: string | null;
  selectedSession: string | null;
  sessionEvents: SessionEvent[];
  sessionList: string[];

  setAgents: (agents: AgentState[]) => void;
  updateAgent: (name: string, update: Partial<AgentState>) => void;
  removeAgent: (name: string) => void;
  addAgent: (agent: AgentState) => void;
  setConnected: (v: boolean) => void;
  selectAgent: (name: string | null) => void;
  selectSession: (id: string | null) => void;
  setSessionEvents: (events: SessionEvent[]) => void;
  appendEvent: (event: SessionEvent) => void;
  setSessionList: (list: string[]) => void;
}

export const useFleetStore = create<FleetStore>((set, get) => ({
  agents: [],
  workspaces: [],
  runtimes: [],
  connected: false,
  selectedAgent: null,
  selectedSession: null,
  sessionEvents: [],
  sessionList: [],

  setAgents: (agents) => set({ agents }),
  updateAgent: (name, update) => set((s) => ({
    agents: s.agents.map((a) => a.name === name ? { ...a, ...update } : a),
  })),
  removeAgent: (name) => set((s) => ({
    agents: s.agents.filter((a) => a.name !== name),
    selectedAgent: s.selectedAgent === name ? null : s.selectedAgent,
  })),
  addAgent: (agent) => set((s) => ({
    agents: [...s.agents.filter((a) => a.name !== agent.name), agent],
  })),
  setConnected: (connected) => set({ connected }),
  selectAgent: (name) => set({ selectedAgent: name, sessionEvents: [], selectedSession: null }),
  selectSession: (id) => set({ selectedSession: id, sessionEvents: [] }),
  setSessionEvents: (events) => set({ sessionEvents: events }),
  appendEvent: (event) => set((s) => ({ sessionEvents: [...s.sessionEvents, event] })),
  setSessionList: (list) => set({ sessionList: list }),
}));

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectWS() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    useFleetStore.getState().setConnected(true);
    console.log("[ws] connected");
  };

  ws.onclose = () => {
    useFleetStore.getState().setConnected(false);
    console.log("[ws] disconnected, reconnecting in 3s...");
    reconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const store = useFleetStore.getState();

    switch (msg.type) {
      case "fleet_snapshot":
        useFleetStore.setState({
          agents: msg.agents || [],
          workspaces: msg.workspaces || [],
          runtimes: msg.runtimes || [],
        });
        break;

      case "event": {
        const event = msg.event;
        switch (event.type) {
          case "agent_spawned":
            // Refresh fleet via REST for full agent state
            fetchFleet();
            break;
          case "agent_killed":
            store.removeAgent(event.agentName);
            break;
          case "status_change":
            store.updateAgent(event.agentName, { status: event.payload?.status, lastActivity: event.ts });
            break;
          case "user_message":
          case "agent_message":
          case "error":
            store.updateAgent(event.agentName, { lastActivity: event.ts });
            if (store.selectedAgent === event.agentName) {
              store.appendEvent({
                ts: event.ts,
                type: event.type,
                text: event.payload?.text,
                error: event.payload?.error,
              });
            }
            break;
          case "session_cleared":
            store.updateAgent(event.agentName, {
              currentSessionId: event.payload?.newSessionId,
              messageCount: 0,
            });
            if (store.selectedAgent === event.agentName) {
              useFleetStore.setState({ sessionEvents: [], selectedSession: null });
              fetchSessionList(event.agentName);
            }
            break;
        }
        break;
      }
    }
  };
}

export async function fetchFleet() {
  try {
    const res = await fetch("/api/fleet");
    const data = await res.json();
    useFleetStore.setState({
      agents: data.agents || [],
      workspaces: data.workspaces || [],
      runtimes: data.runtimes || [],
    });
  } catch {}
}

export async function fetchSessionEvents(agentName: string, sessionId?: string) {
  const id = sessionId || useFleetStore.getState().agents.find((a) => a.name === agentName)?.currentSessionId;
  if (!id) return;
  try {
    const res = await fetch(`/api/agents/${agentName}/events?limit=200&session=${id}`);
    const data = await res.json();
    useFleetStore.setState({ sessionEvents: data.events || [] });
  } catch {}
}

export async function fetchSessionList(agentName: string) {
  try {
    const res = await fetch(`/api/agents/${agentName}/sessions`);
    const data = await res.json();
    useFleetStore.setState({ sessionList: data.sessions || [] });
  } catch {
    useFleetStore.setState({ sessionList: [] });
  }
}
