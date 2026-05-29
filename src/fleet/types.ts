import type { RuntimeType } from "../config.js";

export type AgentStatus = "waiting" | "sleeping" | "working" | "error" | "stopped" | "dead";

export type FleetEventType =
  | "agent_spawned"
  | "agent_killed"
  | "session_started"
  | "session_cleared"
  | "session_named"
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
  displayName?: string;
  title?: string;
  personality?: string;
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
  lastUserMessageAt?: string;
  lastAgentMessage?: string;
  inferred?: string;
  sessionName?: string;
}

export interface FleetState {
  agents: Record<string, AgentState>;
  version: number;
  lastUpdated: string;
}

export interface MediaAttachmentMeta {
  type: "photo" | "document" | "video" | "voice" | "animation";
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  url?: string;
  caption?: string;
}

export type MessageSender = "user" | string; // "user" or agent name

export interface QueuedMessage {
  text: string;
  sender: MessageSender;
  attachments?: MediaAttachmentMeta[];
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
}

export interface WorkspaceEntry {
  alias: string;
  path: string;
}

export type FleetActivityType =
  | "send_success"
  | "send_failed"
  | "agent_waking"
  | "agent_completed"
  | "agent_died"
  | "agent_timeout"
  | "tool_block_parse_error"
  | "narrate_without_emit";

export interface FleetActivityEvent {
  type: FleetActivityType;
  agent: string;
  detail: Record<string, unknown>;
}
