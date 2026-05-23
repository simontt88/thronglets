import type { FleetManager, WorkspaceEntry } from "./manager.js";
import type { FleetEventBus } from "./event-bus.js";
import type { BridgeConfig, RuntimeType } from "../config.js";

const DISPATCHER_NAME = "_dispatcher";

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

  subscribeToFleetEvents(bus, fleet);

  return !result.includes("already exists") && !result.includes("Unknown");
}

function subscribeToFleetEvents(
  bus: FleetEventBus,
  fleet: FleetManager,
): void {
  const relevantEvents = new Set([
    "agent_spawned", "agent_killed", "status_change", "session_cleared",
  ]);

  bus.onEvent((event) => {
    if (!relevantEvents.has(event.type)) return;
    if (event.agentName === DISPATCHER_NAME) return;
    console.log(`[dispatcher] fleet changed (${event.type} on ${event.agentName}): ${fleet.getStatus().total} agents — preamble will refresh on next message`);
  });
}

export const DISPATCHER_AGENT_NAME = DISPATCHER_NAME;
