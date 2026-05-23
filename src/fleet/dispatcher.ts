import type { FleetManager, WorkspaceEntry } from "./manager.js";
import type { FleetEventBus } from "./event-bus.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import { getToolInstructions } from "./tool-instructions.js";

const DISPATCHER_NAME = "_dispatcher";

function buildSystemPrompt(): string {
  return `You are the Thronglets Fleet Dispatcher — an AI orchestrator that routes user requests to the best available thronglet.

## Your role
You manage a fleet of thronglets (coding agents). Each thronglet runs in a specific workspace with a specific runtime (cursor, claude-code, or codex).

When a user sends you a message, you should:
1. Analyze what they need done
2. Decide which thronglet(s) should handle it based on workspace match, runtime strength, and current load
3. Forward the task using the fleet tools below
4. Report back briefly with the plan

## Routing intelligence
- **cursor**: Best for in-IDE edits, refactors, code review, targeted file changes, TypeScript/React work
- **claude-code**: Best for terminal tasks, multi-step sweeps, synthesis, complex analysis, shell scripts
- **codex**: Best for automation, planning, long-running background jobs, parallel experiments
- Match task to thronglet by **workspace first** (already in the right codebase), then by **runtime strength**
- If a task is small and specific, route to one thronglet
- If a task is large ("do X and Y"), consider splitting across thronglets or sending sequential instructions
- If user references a thronglet by name → route to it specifically
- If user references multiple thronglets → parallel fleet_send to all
- If user says "spawn 3 in workspace X" → 3x fleet_spawn
- If user says "add workspace /path/to/repo" → fleet_workspace_add
- If the user's intent is ambiguous, pick the best idle thronglet by workspace match

## Important rules
- Never try to do coding work yourself — always delegate to thronglets
- If no thronglets are available, suggest hatching one (and offer to do it)
- If a thronglet is "dead" or "error", note it and suggest recovery or hatching a replacement
- Be concise in your responses — focus on action over explanation
- When forwarding multi-step work: include enough context in the message so the receiving thronglet can work independently

${getToolInstructions(true)}
`;
}

export interface DispatcherConfig {
  enabled: boolean;
  runtime: RuntimeType;
  model?: string;
  workspace?: string;
}

export function getDispatcherConfig(config: BridgeConfig): DispatcherConfig {
  const raw = config.dispatcher;
  if (!raw) {
    return { enabled: false, runtime: "claude-code" };
  }
  return {
    enabled: raw.enabled !== false,
    runtime: raw.runtime || "claude-code",
    model: raw.model,
    workspace: raw.workspace,
  };
}

export async function startDispatcher(
  fleet: FleetManager,
  bus: FleetEventBus,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): Promise<boolean> {
  const dc = getDispatcherConfig(config);
  if (!dc.enabled) {
    console.log("[dispatcher] disabled (set dispatcher.enabled: true in config)");
    return false;
  }

  if (fleet.hasAgent(DISPATCHER_NAME)) {
    console.log("[dispatcher] already running");
    return true;
  }

  const wsAlias = dc.workspace || workspaces[0]?.alias || "cwd";
  const result = await fleet.spawn(DISPATCHER_NAME, dc.runtime, wsAlias, dc.model);
  console.log(`[dispatcher] ${result}`);

  // Subscribe to fleet events to keep dispatcher context fresh
  subscribeToFleetEvents(bus, fleet, workspaces);

  return !result.includes("already exists") && !result.includes("Unknown");
}

function subscribeToFleetEvents(
  bus: FleetEventBus,
  fleet: FleetManager,
  workspaces: WorkspaceEntry[],
): void {
  const relevantEvents = new Set([
    "agent_spawned", "agent_killed", "status_change", "session_cleared",
  ]);

  bus.onEvent((event) => {
    if (!relevantEvents.has(event.type)) return;
    if (event.agentName === DISPATCHER_NAME) return;

    // Refresh the dispatcher's context awareness (logged for debugging)
    const ctx = buildDispatcherContext(fleet, workspaces);
    console.log(`[dispatcher] context refresh (${event.type} on ${event.agentName}): ${fleet.getStatus().total} agents`);
    // Context is injected dynamically in the next message to dispatcher
    void ctx; // context is rebuilt each time buildDispatcherContext is called
  });
}

export function buildDispatcherContext(
  fleet: FleetManager,
  workspaces: WorkspaceEntry[],
): string {
  const status = fleet.getStatus();
  const agentSummary = status.agents
    .filter((a) => a.name !== DISPATCHER_NAME)
    .map((a) => {
      const parts = [`@${a.name}: ${a.runtime} · ws:${a.workspace} · ${a.status}`];
      if (a.sessionName) parts.push(`「${a.sessionName}」`);
      if (a.inferred && a.status === "working") parts.push(`(${a.inferred})`);
      return `  - ${parts.join(" ")}`;
    })
    .join("\n");

  const wsSummary = workspaces
    .map((w) => `  - ${w.alias}: ${w.path}`)
    .join("\n");

  return [
    buildSystemPrompt(),
    "",
    "## Current fleet state",
    `Total agents: ${status.total - 1} (excluding you) — ${status.working} working, ${status.idle} idle, ${status.dead} dead`,
    agentSummary || "  (no agents spawned — suggest spawning one)",
    "",
    "## Available workspaces",
    wsSummary || "  (none configured)",
  ].join("\n");
}

export const DISPATCHER_AGENT_NAME = DISPATCHER_NAME;
