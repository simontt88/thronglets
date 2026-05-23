import type { FleetManager, WorkspaceEntry } from "./manager.js";
import type { FleetEventBus } from "./event-bus.js";
import type { BridgeConfig, RuntimeType } from "../config.js";

const DISPATCHER_NAME = "_dispatcher";

const DISPATCHER_SYSTEM_PROMPT = `You are the Kenyalang Fleet Dispatcher — an AI orchestrator that routes user requests to the best available agent.

## Your capabilities
You manage a fleet of coding agents. Each agent runs in a specific workspace with a specific runtime (cursor, claude-code, or codex).

When a user sends you a message, you should:
1. Analyze what they need done
2. Decide which agent(s) should handle it
3. Forward the task using the fleet tools below
4. Report back with the plan

## Fleet tools (call via tool_use)
- **fleet_status**: Get current fleet state (agents, statuses, workspaces)
- **fleet_send**: Send a message to a specific agent. Args: { agent: string, text: string }
- **fleet_spawn**: Spawn a new agent. Args: { name: string, runtime: "cursor"|"claude-code"|"codex", workspace: string }
- **fleet_kill**: Kill an agent. Args: { name: string }
- **fleet_clear**: Clear an agent's session. Args: { name: string }

## Routing guidelines
- **cursor**: Best for in-IDE edits, refactors, code review, targeted changes
- **claude-code**: Best for terminal tasks, multi-step sweeps, synthesis, complex analysis
- **codex**: Best for automation, planning, long-running background jobs
- If a task is small and specific, route to one agent
- If a task is large, consider splitting across agents working in parallel
- If the user says "do X in workspace Y", spawn/use an agent in that workspace
- Always explain your routing decision briefly

## Important rules
- Never try to do coding work yourself — always delegate to agents
- If no agents are available, suggest spawning one
- Be concise in your responses
`;

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

  return !result.includes("already exists") && !result.includes("Unknown");
}

export function buildDispatcherContext(
  fleet: FleetManager,
  workspaces: WorkspaceEntry[],
): string {
  const status = fleet.getStatus();
  const agentSummary = status.agents
    .filter((a) => a.name !== DISPATCHER_NAME)
    .map((a) => `  - @${a.name}: ${a.runtime} · ${a.model} · ws:${a.workspace} · status:${a.status}`)
    .join("\n");

  const wsSummary = workspaces
    .map((w) => `  - ${w.alias}: ${w.path}`)
    .join("\n");

  return [
    DISPATCHER_SYSTEM_PROMPT,
    "",
    "## Current fleet state",
    `Total agents: ${status.total} (${status.working} working, ${status.idle} idle)`,
    agentSummary || "  (no agents spawned)",
    "",
    "## Available workspaces",
    wsSummary || "  (none configured)",
  ].join("\n");
}

export const DISPATCHER_AGENT_NAME = DISPATCHER_NAME;
