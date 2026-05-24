import type { FleetManager, FleetEventBus } from "./manager.js";
import type { WorkspaceEntry } from "./types.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import { GLOBAL_CONFIG_DIR } from "../config.js";
import { provisionDispatcherWorkspace } from "./workspace-init.js";
import { addWorkspace } from "./state.js";
import { DISPATCHER_NAME } from "../utils/constants.js";
import { existsSync, mkdirSync, cpSync } from "fs";
import { join } from "path";
const DEFAULT_DISPATCH_DIR = join(GLOBAL_CONFIG_DIR, "dispatch");

export interface DispatcherConfig {
  enabled: boolean;
  runtime: RuntimeType;
  model?: string;
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
    const state = fleet.getAgent(DISPATCHER_NAME);
    if (state && (state.status === "dead" || state.status === "error")) {
      console.log(`[dispatcher] exists but ${state.status} — respawning`);
      await fleet.respawn(DISPATCHER_NAME);
      return true;
    }
    console.log("[dispatcher] already running");
    return true;
  }

  const wsAlias = "dispatch";
  const wsPath = DEFAULT_DISPATCH_DIR;

  let wsEntry = workspaces.find((w) => w.alias === wsAlias);

  if (!wsEntry) {
    if (!existsSync(wsPath)) {
      mkdirSync(wsPath, { recursive: true });
      console.log(`[dispatcher] created workspace directory: ${wsPath}`);
    }

    addWorkspace(wsAlias, wsPath);
    workspaces.push({ alias: wsAlias, path: wsPath });
    wsEntry = workspaces[workspaces.length - 1];
    console.log(`[dispatcher] registered workspace: ${wsAlias} → ${wsPath}`);
  } else if (wsEntry.path !== wsPath) {
    const oldPath = wsEntry.path;
    migrateDispatcherData(oldPath, wsPath);
    wsEntry.path = wsPath;
    addWorkspace(wsAlias, wsPath);
    console.log(`[dispatcher] corrected workspace path: ${wsAlias} → ${wsPath}`);
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

const DISPATCHER_FILES = ["AGENTS.md", "memory", "tools"];

function migrateDispatcherData(oldPath: string, newPath: string): void {
  if (!existsSync(oldPath)) return;
  if (oldPath === newPath) return;

  const itemsToMigrate = DISPATCHER_FILES.filter(
    (item) => existsSync(join(oldPath, item)) && !existsSync(join(newPath, item)),
  );

  if (itemsToMigrate.length === 0) return;

  mkdirSync(newPath, { recursive: true });
  for (const item of itemsToMigrate) {
    try {
      cpSync(join(oldPath, item), join(newPath, item), { recursive: true });
      console.log(`[dispatcher] migrated ${item} from ${oldPath}`);
    } catch (err) {
      console.warn(`[dispatcher] failed to migrate ${item}: ${(err as Error).message}`);
    }
  }
  console.log(`[dispatcher] migrated ${itemsToMigrate.length} item(s) from old path — original files left untouched`);
}

export const DISPATCHER_AGENT_NAME = DISPATCHER_NAME;
