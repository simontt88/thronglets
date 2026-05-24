import type { FleetManager, FleetEventBus } from "./manager.js";
import type { WorkspaceEntry } from "./types.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import { GLOBAL_CONFIG_DIR } from "../config.js";
import { provisionDispatcherWorkspace } from "./workspace-init.js";
import { addWorkspace } from "./state.js";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DISPATCHER_NAME = "_dispatcher";
const DEFAULT_DISPATCH_DIR = join(GLOBAL_CONFIG_DIR, "dispatch");

export interface DispatcherConfig {
  enabled: boolean;
  runtime: RuntimeType;
  model?: string;
  workspace?: string;
}

export function getDispatcherConfig(config: BridgeConfig): DispatcherConfig {
  const raw = config.dispatcher;
  if (!raw) {
    return { enabled: false, runtime: "cursor" };
  }
  return {
    enabled: raw.enabled !== false,
    runtime: raw.runtime || "cursor",
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

  const wsAlias = dc.workspace || "dispatch";

  let wsEntry = workspaces.find((w) => w.alias === wsAlias);

  // Auto-create dispatcher workspace if not registered
  if (!wsEntry) {
    // If workspace value looks like a path, use it; otherwise create under THRONGLETS_HOME
    const wsPath = dc.workspace && (dc.workspace.startsWith("/") || dc.workspace.startsWith("~"))
      ? dc.workspace.replace(/^~/, homedir())
      : DEFAULT_DISPATCH_DIR;

    if (!existsSync(wsPath)) {
      mkdirSync(wsPath, { recursive: true });
      console.log(`[dispatcher] created workspace directory: ${wsPath}`);
    }

    addWorkspace(wsAlias, wsPath);
    workspaces.push({ alias: wsAlias, path: wsPath });
    wsEntry = workspaces[workspaces.length - 1];
    console.log(`[dispatcher] auto-registered workspace: ${wsAlias} → ${wsPath}`);
  }

  // Provision AGENTS.md, memory/, tools/ if missing
  provisionDispatcherWorkspace(wsEntry.path);

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
