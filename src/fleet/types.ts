import type { RuntimeType } from "../config.js";

export type AgentStatus = "idle" | "working" | "error" | "stopped";

export type FleetEventType =
  | "agent_spawned"
  | "agent_killed"
  | "session_started"
  | "session_cleared"
  | "user_message"
  | "agent_thinking"
  | "tool_call"
  | "tool_result"
  | "agent_message"
  | "status_change"
  | "error";

export interface FleetEvent {
  ts: string;
  type: FleetEventType;
  agentName: string;
  sessionId: string;
  payload?: unknown;
}

export interface AgentState {
  name: string;
  runtime: RuntimeType;
  model: string;
  workspace: string;
  workspacePath: string;
  status: AgentStatus;
  currentSessionId: string;
  spawnedAt: string;
  lastActivity: string;
  messageCount: number;
  lastUserMessage?: string;
  lastAgentMessage?: string;
  inferred?: string;
}

export interface FleetState {
  agents: Record<string, AgentState>;
  version: number;
  lastUpdated: string;
}
