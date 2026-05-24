import { readFileSync, existsSync, renameSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

export type TransportType = "telegram" | "lark" | "discord";
export type RuntimeType = "cursor" | "claude-code" | "codex";
export type PermissionMode = "readonly" | "safe" | "full" | "custom";
export type RecallMode = "local" | "cloud" | "both" | "off";
export type CommsMode = "swarm" | "hive" | "leash";
export type VisibilityLevel = "full" | "summary" | "off";

export interface TelegramConfig {
  token: string;
  allowedChats?: string[];
}

export interface LarkConfig {
  appId: string;
  appSecret: string;
  allowedChats?: string[];
}

export interface DiscordConfig {
  token: string;
  allowedUsers?: string[];
}

export interface AgentDef {
  name: string;
  runtime: RuntimeType;
  apiKey: string;
  model: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalPolicy?: string;
}

export interface SessionConfig {
  logDir: string;
  storeDir?: string;
  recall: RecallMode;
  recallApi?: string;
  recallKey?: string;
}

export interface DispatcherDef {
  enabled?: boolean;
  runtime?: RuntimeType;
  model?: string;
  workspace?: string;
}

export interface FleetTimeouts {
  sendTimeoutMs: number;
  sessionMaxAgeMs: number;
  stuckWorkingGraceMs: number;
  healthCheckIntervalMs: number;
}

export const DEFAULT_TIMEOUTS: FleetTimeouts = {
  sendTimeoutMs: 60 * 60 * 1000,          // 1 hour
  sessionMaxAgeMs: 30 * 60 * 1000,        // 30 min
  stuckWorkingGraceMs: 61 * 60 * 1000,    // 1 hour + 1 min grace
  healthCheckIntervalMs: 30 * 1000,       // 30 sec
};

export interface FleetConfig {
  comms: CommsMode;
  timeouts: FleetTimeouts;
  visibility: {
    interAgent: VisibilityLevel;
    toolCalls: boolean;
  };
}

export interface BridgeConfig {
  transport: TransportType;
  workspace: string;

  telegram?: TelegramConfig;
  lark?: LarkConfig;
  discord?: DiscordConfig;

  agents: AgentDef[];
  active: string;

  permissions?: { mode: PermissionMode };
  session?: SessionConfig;
  dispatcher?: DispatcherDef;
  fleet: FleetConfig;
}

const LEGACY_DIRS = [".agent-bridge", ".kenyalang"];
const DEFAULT_DIR = ".thronglets";

function resolveConfigDir(): string {
  if (process.env.THRONGLETS_HOME) return process.env.THRONGLETS_HOME;

  const defaultPath = join(homedir(), DEFAULT_DIR);
  if (existsSync(defaultPath)) return defaultPath;

  for (const legacy of LEGACY_DIRS) {
    const legacyPath = join(homedir(), legacy);
    if (existsSync(legacyPath)) {
      console.log(`[config] found legacy config at ~/${legacy}`);
      console.log(`[config] migrating: ~/${legacy} → ~/${DEFAULT_DIR}`);
      try {
        renameSync(legacyPath, defaultPath);
        console.log(`[config] migration complete`);
        return defaultPath;
      } catch (err) {
        console.warn(`[config] auto-migrate failed (${(err as Error).message}), using ~/${legacy} as-is`);
        console.warn(`[config] set THRONGLETS_HOME=~/${legacy} or manually rename to ~/${DEFAULT_DIR}`);
        return legacyPath;
      }
    }
  }

  return defaultPath;
}

export const GLOBAL_CONFIG_DIR = resolveConfigDir();
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.yaml");

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || "");
}

function resolveDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveDeep);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveDeep(v);
    }
    return result;
  }
  return obj;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === "object" && !Array.isArray(v) && result[k] && typeof result[k] === "object") {
      result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined && v !== null && v !== "") {
      result[k] = v;
    }
  }
  return result;
}

function loadYamlFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    return parseYaml(content) || null;
  } catch {
    return null;
  }
}

function parseAgents(raw: unknown): AgentDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((a: Record<string, unknown>) => ({
    name: (a.name as string) || "default",
    runtime: (a.runtime as RuntimeType) || "cursor",
    apiKey: (a.api_key || a.apiKey || "") as string,
    model: (a.model as string) || "",
    permissionMode: (a.permission_mode || a.permissionMode) as string | undefined,
    allowedTools: (a.allowed_tools || a.allowedTools) as string[] | undefined,
    disallowedTools: (a.disallowed_tools || a.disallowedTools) as string[] | undefined,
    approvalPolicy: (a.approval_policy || a.approvalPolicy) as string | undefined,
  }));
}

export function loadConfig(): BridgeConfig {
  const workspace = resolve(
    process.env._BRIDGE_RESOLVED_WORKSPACE || process.env.BRIDGE_WORKSPACE || process.cwd()
  );

  let merged: Record<string, unknown> = loadYamlFile(GLOBAL_CONFIG_PATH) || {};
  if (Object.keys(merged).length) {
    console.log(`[config] loaded global: ${GLOBAL_CONFIG_PATH}`);
  }

  const explicitConfig = process.env._BRIDGE_CONFIG_PATH;
  const workspaceConfigPaths = explicitConfig
    ? [explicitConfig]
    : [join(workspace, "bridge.yaml"), join(workspace, "bridge.yml")];

  for (const p of workspaceConfigPaths) {
    const local = loadYamlFile(p);
    if (local) {
      merged = deepMerge(merged, local);
      console.log(`[config] loaded workspace: ${p}`);
      break;
    }
  }

  const resolved = resolveDeep(merged) as Record<string, unknown>;

  const rawTelegram = resolved.telegram as Record<string, unknown> | undefined;
  const rawLark = resolved.lark as Record<string, unknown> | undefined;
  const rawDiscord = resolved.discord as Record<string, unknown> | undefined;
  const rawSession = resolved.session as Record<string, unknown> | undefined;
  const rawPermissions = resolved.permissions as Record<string, unknown> | undefined;
  const rawDispatcher = resolved.dispatcher as Record<string, unknown> | boolean | undefined;
  const rawFleet = resolved.fleet as Record<string, unknown> | undefined;
  const rawVisibility = rawFleet?.visibility as Record<string, unknown> | undefined;
  const rawTimeouts = rawFleet?.timeouts as Record<string, unknown> | undefined;

  const agents = parseAgents(resolved.agents);

  // Backward compat: if no "agents" array, build from old single-runtime config
  if (!agents.length) {
    const rawCursor = resolved.cursor as Record<string, unknown> | undefined;
    if (rawCursor) {
      agents.push({
        name: "cursor",
        runtime: "cursor",
        apiKey: (rawCursor.api_key || rawCursor.apiKey || "") as string,
        model: (rawCursor.model as string) || "claude-opus-4-6",
      });
    }
  }

  const config: BridgeConfig = {
    transport: (resolved.transport as string || "telegram") as TransportType,
    workspace,

    telegram: rawTelegram ? {
      token: (rawTelegram.token as string) || "",
      allowedChats: (rawTelegram.allowed_chats || rawTelegram.allowedChats) as string[] | undefined,
    } : undefined,

    lark: rawLark ? {
      appId: (rawLark.app_id || rawLark.appId || "") as string,
      appSecret: (rawLark.app_secret || rawLark.appSecret || "") as string,
      allowedChats: (rawLark.allowed_chats || rawLark.allowedChats) as string[] | undefined,
    } : undefined,

    discord: rawDiscord ? {
      token: (rawDiscord.token as string) || "",
      allowedUsers: (rawDiscord.allowed_users || rawDiscord.allowedUsers) as string[] | undefined,
    } : undefined,

    agents,
    active: (resolved.active as string) || agents[0]?.name || "",

    permissions: rawPermissions ? {
      mode: (rawPermissions.mode as PermissionMode) || "safe",
    } : { mode: "safe" },

    dispatcher: rawDispatcher
      ? typeof rawDispatcher === "boolean"
        ? { enabled: rawDispatcher }
        : {
            enabled: (rawDispatcher.enabled as boolean) !== false,
            runtime: rawDispatcher.runtime as RuntimeType | undefined,
            model: rawDispatcher.model as string | undefined,
            workspace: rawDispatcher.workspace as string | undefined,
          }
      : undefined,

    fleet: {
      comms: (rawFleet?.comms as CommsMode) || "hive",
      timeouts: {
        sendTimeoutMs: Number(rawTimeouts?.send_timeout_ms ?? rawTimeouts?.sendTimeoutMs ?? DEFAULT_TIMEOUTS.sendTimeoutMs),
        sessionMaxAgeMs: Number(rawTimeouts?.session_max_age_ms ?? rawTimeouts?.sessionMaxAgeMs ?? DEFAULT_TIMEOUTS.sessionMaxAgeMs),
        stuckWorkingGraceMs: Number(rawTimeouts?.stuck_working_grace_ms ?? rawTimeouts?.stuckWorkingGraceMs ?? DEFAULT_TIMEOUTS.stuckWorkingGraceMs),
        healthCheckIntervalMs: Number(rawTimeouts?.health_check_interval_ms ?? rawTimeouts?.healthCheckIntervalMs ?? DEFAULT_TIMEOUTS.healthCheckIntervalMs),
      },
      visibility: {
        interAgent: (rawVisibility?.inter_agent || rawVisibility?.interAgent || "summary") as VisibilityLevel,
        toolCalls: rawVisibility?.tool_calls !== false && rawVisibility?.toolCalls !== false,
      },
    },

    session: rawSession ? {
      logDir: (rawSession.log_dir || rawSession.logDir || "") as string,
      storeDir: (rawSession.store_dir || rawSession.storeDir) as string | undefined,
      recall: (rawSession.recall as RecallMode) || "local",
      recallApi: (rawSession.recall_api || rawSession.recallApi) as string | undefined,
      recallKey: (rawSession.recall_key || rawSession.recallKey) as string | undefined,
    } : undefined,
  };

  // Defaults
  if (!config.session) {
    config.session = { logDir: join(GLOBAL_CONFIG_DIR, "logs"), recall: "local" };
  }
  if (!config.session.logDir) {
    config.session.logDir = join(GLOBAL_CONFIG_DIR, "logs");
  }
  config.session.logDir = resolve(config.session.logDir.replace(/^~/, homedir()));

  if (config.session.storeDir) {
    config.session.storeDir = resolve(
      config.session.storeDir.startsWith("~")
        ? config.session.storeDir.replace(/^~/, homedir())
        : config.session.storeDir.startsWith("/")
          ? config.session.storeDir
          : join(workspace, config.session.storeDir)
    );
  } else {
    config.session.storeDir = join(workspace, ".thronglets");
  }

  return config;
}

export function getAgentByName(config: BridgeConfig, name: string): AgentDef | undefined {
  return config.agents.find((a) => a.name === name);
}
