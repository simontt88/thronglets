import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

export interface BridgeConfig {
  transport: "telegram" | "lark" | "slack" | "discord";
  runtime: "cursor" | "claude" | "codex";
  workspace: string;

  telegram?: {
    token: string;
    allowedChats?: string[];
  };

  cursor?: {
    apiKey: string;
    model: string;
  };

  session?: {
    logDir: string;
    recallApi?: string;
    recallKey?: string;
  };
}

const GLOBAL_CONFIG_DIR = join(homedir(), ".agent-bridge");
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

function buildFromEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};

  if (process.env.BRIDGE_TRANSPORT) env.transport = process.env.BRIDGE_TRANSPORT;
  if (process.env.BRIDGE_RUNTIME) env.runtime = process.env.BRIDGE_RUNTIME;
  if (process.env.BRIDGE_WORKSPACE || process.env._BRIDGE_RESOLVED_WORKSPACE) {
    env.workspace = process.env._BRIDGE_RESOLVED_WORKSPACE || process.env.BRIDGE_WORKSPACE;
  }

  const telegram: Record<string, unknown> = {};
  if (process.env.TELEGRAM_BOT_TOKEN) telegram.token = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_ALLOWED_CHATS) {
    telegram.allowedChats = process.env.TELEGRAM_ALLOWED_CHATS.split(",").map((s) => s.trim());
  }
  if (Object.keys(telegram).length) env.telegram = telegram;

  const cursor: Record<string, unknown> = {};
  if (process.env.CURSOR_API_KEY) cursor.apiKey = process.env.CURSOR_API_KEY;
  if (process.env.CURSOR_MODEL) cursor.model = process.env.CURSOR_MODEL;
  if (Object.keys(cursor).length) env.cursor = cursor;

  const session: Record<string, unknown> = {};
  if (process.env.BRIDGE_LOG_DIR) session.logDir = process.env.BRIDGE_LOG_DIR;
  if (process.env.RECALL_API_URL) session.recallApi = process.env.RECALL_API_URL;
  if (process.env.RECALL_API_KEY) session.recallKey = process.env.RECALL_API_KEY;
  if (Object.keys(session).length) env.session = session;

  return env;
}

export function loadConfig(): BridgeConfig {
  const workspace = resolve(
    process.env._BRIDGE_RESOLVED_WORKSPACE || process.env.BRIDGE_WORKSPACE || process.cwd()
  );

  // Layer 1: Global config (~/.agent-bridge/config.yaml)
  let merged: Record<string, unknown> = loadYamlFile(GLOBAL_CONFIG_PATH) || {};
  if (Object.keys(merged).length) {
    console.log(`[config] loaded global: ${GLOBAL_CONFIG_PATH}`);
  }

  // Layer 2: Workspace-local config ({workspace}/bridge.yaml)
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

  // Layer 3: Environment variables (highest priority)
  const envOverrides = buildFromEnv();
  merged = deepMerge(merged, envOverrides);

  // Resolve ${VAR} references
  const resolved = resolveDeep(merged) as Record<string, unknown>;

  // Normalize snake_case keys from YAML to camelCase
  const rawTelegram = resolved.telegram as Record<string, unknown> | undefined;
  const rawCursor = resolved.cursor as Record<string, unknown> | undefined;
  const rawSession = resolved.session as Record<string, unknown> | undefined;

  const config: BridgeConfig = {
    transport: (resolved.transport as string || "telegram") as BridgeConfig["transport"],
    runtime: (resolved.runtime as string || "cursor") as BridgeConfig["runtime"],
    workspace,
    telegram: rawTelegram ? {
      token: (rawTelegram.token as string) || "",
      allowedChats: (rawTelegram.allowed_chats || rawTelegram.allowedChats) as string[] | undefined,
    } : undefined,
    cursor: rawCursor ? {
      apiKey: (rawCursor.api_key || rawCursor.apiKey) as string || "",
      model: (rawCursor.model as string) || "claude-opus-4-6",
    } : undefined,
    session: rawSession ? {
      logDir: (rawSession.log_dir || rawSession.logDir) as string || "",
      recallApi: (rawSession.recall_api || rawSession.recallApi) as string | undefined,
      recallKey: (rawSession.recall_key || rawSession.recallKey) as string | undefined,
    } : undefined,
  };

  // Defaults
  if (!config.session) {
    config.session = { logDir: join(GLOBAL_CONFIG_DIR, "logs") };
  }
  if (!config.session.logDir) {
    config.session.logDir = join(GLOBAL_CONFIG_DIR, "logs");
  }
  config.session.logDir = resolve(config.session.logDir.replace(/^~/, homedir()));

  return config;
}
