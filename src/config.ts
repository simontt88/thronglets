import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
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

export function loadConfig(configPath?: string): BridgeConfig {
  const searchPaths = configPath
    ? [configPath]
    : [
        join(process.cwd(), "bridge.yaml"),
        join(process.cwd(), "bridge.yml"),
        join(process.cwd(), "bridge.json"),
      ];

  let raw: Record<string, unknown> | null = null;

  for (const p of searchPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      if (p.endsWith(".json")) {
        raw = JSON.parse(content);
      } else {
        raw = parseYaml(content);
      }
      console.log(`[config] loaded from ${p}`);
      break;
    }
  }

  if (!raw) {
    raw = buildFromEnv();
    console.log(`[config] built from environment variables`);
  }

  const resolved = resolveDeep(raw) as Record<string, unknown>;

  const config: BridgeConfig = {
    transport: (resolved.transport as string || "telegram") as BridgeConfig["transport"],
    runtime: (resolved.runtime as string || "cursor") as BridgeConfig["runtime"],
    workspace: resolve(resolved.workspace as string || "."),

    telegram: resolved.telegram as BridgeConfig["telegram"],
    cursor: resolved.cursor as BridgeConfig["cursor"],
    session: resolved.session as BridgeConfig["session"],
  };

  // Defaults
  if (!config.session) {
    config.session = { logDir: join(process.cwd(), "logs") };
  }
  if (!config.session.logDir) {
    config.session.logDir = join(process.cwd(), "logs");
  }

  return config;
}

function buildFromEnv(): Record<string, unknown> {
  return {
    transport: process.env.BRIDGE_TRANSPORT || "telegram",
    runtime: process.env.BRIDGE_RUNTIME || "cursor",
    workspace: process.env.BRIDGE_WORKSPACE || ".",

    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || "",
      allowedChats: process.env.TELEGRAM_ALLOWED_CHATS?.split(",").map((s) => s.trim()) || [],
    },

    cursor: {
      apiKey: process.env.CURSOR_API_KEY || "",
      model: process.env.CURSOR_MODEL || "claude-opus-4-6",
    },

    session: {
      logDir: process.env.BRIDGE_LOG_DIR || "./logs",
      recallApi: process.env.RECALL_API_URL || "",
      recallKey: process.env.RECALL_API_KEY || "",
    },
  };
}
