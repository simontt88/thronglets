import { loadConfig, getAgentByName, type BridgeConfig, type AgentDef, type RuntimeType } from "./config.js";
import { TelegramTransport } from "./transports/telegram.js";
import { CursorRuntime } from "./runtimes/cursor.js";
import { ClaudeCodeRuntime } from "./runtimes/claude-code.js";
import { CodexRuntime } from "./runtimes/codex.js";
import { FleetManager, FleetEventBus } from "./fleet/index.js";
import type { WorkspaceEntry } from "./fleet/index.js";
import { syncRules } from "./rules-sync.js";
import type { Transport } from "./transports/interface.js";
import type { Runtime } from "./runtimes/interface.js";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

const RESTART_DELAY_MS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTransport(cfg: BridgeConfig): Transport {
  switch (cfg.transport) {
    case "telegram":
      if (!cfg.telegram?.token) {
        console.error("[fatal] telegram.token is required");
        process.exit(1);
      }
      return new TelegramTransport({
        token: cfg.telegram.token,
        allowedChats: cfg.telegram.allowedChats,
      });

    case "lark": {
      const { LarkTransport } = require("./transports/lark.js");
      if (!cfg.lark?.appId || !cfg.lark?.appSecret) {
        console.error("[fatal] lark.app_id and lark.app_secret are required");
        process.exit(1);
      }
      return new LarkTransport({
        appId: cfg.lark.appId,
        appSecret: cfg.lark.appSecret,
        allowedChats: cfg.lark.allowedChats,
      });
    }

    case "discord": {
      const { DiscordTransport } = require("./transports/discord.js");
      if (!cfg.discord?.token) {
        console.error("[fatal] discord.token is required");
        process.exit(1);
      }
      return new DiscordTransport({
        token: cfg.discord.token,
        allowedUsers: cfg.discord.allowedUsers,
      });
    }

    default:
      console.error(`[fatal] unsupported transport: ${cfg.transport}`);
      process.exit(1);
  }
}

function createRuntime(agent: AgentDef): Runtime {
  switch (agent.runtime) {
    case "cursor":
      return new CursorRuntime({ apiKey: agent.apiKey, model: agent.model });
    case "claude-code":
      return new ClaudeCodeRuntime({
        model: agent.model,
        permissionMode: agent.permissionMode,
        allowedTools: agent.allowedTools,
        disallowedTools: agent.disallowedTools,
      });
    case "codex":
      return new CodexRuntime({
        model: agent.model,
        approvalPolicy: agent.approvalPolicy,
      });
    default:
      console.error(`[fatal] unsupported runtime: ${agent.runtime}`);
      process.exit(1);
  }
}

async function ensureRulesSync(agentDef: AgentDef, workspace: string) {
  if (agentDef.runtime === "claude-code") {
    try { await syncRules(workspace, "claude-code"); }
    catch (err) { console.warn(`[rules-sync] claude-code: ${(err as Error).message}`); }
  } else if (agentDef.runtime === "codex") {
    try { await syncRules(workspace, "codex"); }
    catch (err) { console.warn(`[rules-sync] codex: ${(err as Error).message}`); }
  }
}

function loadWorkspaces(): WorkspaceEntry[] {
  const wsFile = join(homedir(), ".agent-bridge", "workspaces.yaml");
  if (!existsSync(wsFile)) return [];
  try {
    const raw = parseYaml(readFileSync(wsFile, "utf-8"));
    if (!raw?.workspaces) return [];
    return Object.entries(raw.workspaces).map(([alias, val]: [string, any]) => ({
      alias,
      path: val.path || val,
    }));
  } catch {
    return [];
  }
}

function parseAtMentions(text: string): { mentions: string[]; body: string } {
  const mentionRegex = /^(@\w+\s*)+/;
  const match = text.match(mentionRegex);
  if (!match) return { mentions: [], body: text };

  const mentionStr = match[0];
  const body = text.slice(mentionStr.length).trim();
  const mentions = [...mentionStr.matchAll(/@(\w+)/g)].map((m) => m[1]);
  return { mentions, body };
}

async function main() {
  const config = loadConfig();

  if (!config.agents.length) {
    console.error("[fatal] no agents configured. Add an 'agents:' section to your bridge.yaml");
    process.exit(1);
  }

  const transport = createTransport(config);
  const bus = new FleetEventBus();

  // Load registered workspaces + ensure current workspace is included
  const workspaces = loadWorkspaces();
  const cwdAlias = workspaces.find((w) => w.path === config.workspace);
  if (!cwdAlias) {
    workspaces.push({ alias: "cwd", path: config.workspace });
  }

  const fleet = new FleetManager(bus, {
    workspaces,
    createRuntime: (agentDef: AgentDef) => createRuntime(agentDef),
    ensureRulesSync: (agentDef: AgentDef) => ensureRulesSync(agentDef, config.workspace),
    getAgentDef: (runtime: RuntimeType, model?: string) => {
      const match = config.agents.find((a) => a.runtime === runtime);
      if (match) return model ? { ...match, model } : match;
      return {
        name: runtime,
        runtime,
        apiKey: "",
        model: model || "claude-sonnet-4-6",
      };
    },
  });

  // Restore fleet from disk
  await fleet.restore();

  // Log all events
  bus.onEvent((event) => {
    const detail = event.payload ? ` ${JSON.stringify(event.payload).slice(0, 80)}` : "";
    console.log(`[fleet] ${event.type} agent=${event.agentName} session=${event.sessionId.slice(0, 12)}${detail}`);
  });

  transport.onMessage(async (msg) => {
    const { chatId, text } = msg;

    // ── Command handling ──────────────────────────────────────
    if (msg.isCommand) {
      const parts = text.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      switch (cmd) {
        case "/new": {
          const [name, runtime, workspace] = args;
          if (!name) {
            await transport.sendReply(chatId, "Usage: /new <name> [runtime] [workspace]\n\nRuntimes: cursor, claude-code, codex\nWorkspaces: " + workspaces.map((w) => w.alias).join(", "));
            return;
          }
          const rt = (runtime || config.agents[0]?.runtime || "cursor") as RuntimeType;
          const ws = workspace || cwdAlias?.alias || workspaces[0]?.alias || "cwd";
          const result = await fleet.spawn(name, rt, ws);
          await transport.sendReply(chatId, result);
          return;
        }

        case "/kill": {
          const name = args[0];
          if (!name) {
            await transport.sendReply(chatId, "Usage: /kill <name>");
            return;
          }
          const result = await fleet.kill(name);
          await transport.sendReply(chatId, result);
          return;
        }

        case "/clear": {
          const name = args[0];
          if (!name) {
            await transport.sendReply(chatId, "Usage: /clear <name>");
            return;
          }
          const result = await fleet.clear(name);
          await transport.sendReply(chatId, result);
          return;
        }

        case "/fleet": {
          const status = fleet.getStatus();
          if (status.total === 0) {
            await transport.sendReply(chatId, "No agents running.\nSpawn one: /new <name> <runtime> <workspace>");
            return;
          }
          const lines = status.agents.map((a) => {
            const dot = a.status === "working" ? "\u25CF" : a.status === "error" ? "\u2716" : "\u25CB";
            const age = timeSince(a.lastActivity);
            return `${dot} ${a.name} \u2014 ${a.runtime} \u00B7 ${a.workspace} \u2014 ${a.status} (${age})`;
          });
          const header = `Fleet: ${status.total} agents (${status.working} working, ${status.idle} idle)`;
          await transport.sendReply(chatId, `${header}\n\n${lines.join("\n")}`);
          return;
        }

        case "/status": {
          const name = args[0];
          if (name) {
            const agent = fleet.getAgent(name);
            if (!agent) {
              await transport.sendReply(chatId, `Agent "${name}" not found.`);
              return;
            }
            const lines = [
              `Agent: ${agent.name}`,
              `Runtime: ${agent.runtime}`,
              `Model: ${agent.model}`,
              `Workspace: ${agent.workspace} (${agent.workspacePath})`,
              `Status: ${agent.status}`,
              `Session: ${agent.currentSessionId}`,
              `Messages: ${agent.messageCount}`,
              `Spawned: ${agent.spawnedAt}`,
            ];
            await transport.sendReply(chatId, lines.join("\n"));
          } else {
            const status = fleet.getStatus();
            await transport.sendReply(chatId, `Fleet: ${status.total} agents, ${status.working} working\nUse /fleet for details or /status <name> for agent info`);
          }
          return;
        }

        case "/help":
          await transport.sendReply(chatId, [
            "Fleet Commands:",
            "  /new <name> [runtime] [workspace] \u2014 spawn agent",
            "  /kill <name> \u2014 remove agent",
            "  /clear <name> \u2014 archive session, fresh start",
            "  /fleet \u2014 show all agents",
            "  /status [name] \u2014 agent detail",
            "",
            "Messaging:",
            "  @name message \u2014 send to specific agent",
            "  @all message \u2014 broadcast to all agents",
            "",
            `Runtimes: ${config.agents.map((a) => a.runtime).join(", ")}`,
            `Workspaces: ${workspaces.map((w) => w.alias).join(", ")}`,
          ].join("\n"));
          return;

        default:
          await transport.sendReply(chatId, "Unknown command. Try /help");
          return;
      }
    }

    // ── @mention routing ──────────────────────────────────────
    const { mentions, body } = parseAtMentions(text);

    if (mentions.length > 0 && body) {
      const targets = mentions.includes("all") ? fleet.listAgents() : mentions.filter((m) => fleet.hasAgent(m));

      if (targets.length === 0) {
        const available = fleet.listAgents();
        if (available.length === 0) {
          await transport.sendReply(chatId, "No agents running. Use /new to spawn one.");
        } else {
          await transport.sendReply(chatId, `Unknown agent(s): ${mentions.join(", ")}\nAvailable: ${available.join(", ")}`);
        }
        return;
      }

      await transport.sendTyping(chatId);

      // Send to all targets (sequentially to avoid rate limits)
      for (const target of targets) {
        const startTime = Date.now();
        try {
          await transport.sendTyping(chatId);
          const reply = await fleet.send(target, body);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const label = targets.length > 1 ? `[${target} \u00B7 ${elapsed}s]\n` : "";
          await transport.sendReply(chatId, `${label}${reply}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          await transport.sendReply(chatId, `[${target} \u00B7 ${elapsed}s \u00B7 error]\n${errMsg.slice(0, 500)}`);
        }
      }
      return;
    }

    // ── No @mention: send to single default agent (backward compat) ──
    const agentList = fleet.listAgents();
    if (agentList.length === 1) {
      const target = agentList[0];
      await transport.sendTyping(chatId);
      const typingInterval = setInterval(() => { transport.sendTyping(chatId).catch(() => {}); }, 4000);
      try {
        const reply = await fleet.send(target, text);
        await transport.sendReply(chatId, reply);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await transport.sendReply(chatId, `Error: ${errMsg.slice(0, 500)}`);
      } finally {
        clearInterval(typingInterval);
      }
    } else if (agentList.length === 0) {
      await transport.sendReply(chatId, "No agents running. Use /new <name> <runtime> <workspace> to spawn one.\n\nExample: /new alpha cursor cwd");
    } else {
      await transport.sendReply(chatId, `Multiple agents running. Use @name to address one:\n${agentList.map((n) => `  @${n}`).join("\n")}\n  @all (broadcast)`);
    }
  });

  await transport.start();

  console.log(`\nAgent Bridge v0.4.0 (Fleet Mode)`);
  console.log(`  Transport:   ${transport.name}`);
  console.log(`  Workspaces:  ${workspaces.map((w) => `${w.alias}→${w.path.split("/").pop()}`).join(", ")}`);
  console.log(`  Agents def:  ${config.agents.map((a) => `${a.name}(${a.runtime})`).join(", ")}`);
  console.log(`  Fleet:       ${fleet.listAgents().length} restored`);
  console.log(`\n  Commands: /new /kill /fleet /clear /status /help`);
  console.log(`  Mention:  @name message | @all message\n`);

  setInterval(() => {
    const s = fleet.getStatus();
    console.log(`[heartbeat] ${new Date().toISOString()} fleet=${s.total} working=${s.working}`);
  }, 5 * 60 * 1000);
}

function timeSince(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}

async function run() {
  while (true) {
    try {
      await main();
      break;
    } catch (err) {
      console.error(`[crash] ${err instanceof Error ? err.message : err}`);
      console.error(`[crash] restarting in ${RESTART_DELAY_MS / 1000}s...`);
      await sleep(RESTART_DELAY_MS);
    }
  }
}

run();

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error(`[uncaught] ${err.message}`);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[unhandled-rejection] ${reason}`);
});
