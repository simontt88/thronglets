import events from "node:events";
events.setMaxListeners(50);

import { loadConfig, type BridgeConfig, type AgentDef, type RuntimeType } from "./config.js";
import { TelegramTransport } from "./transports/telegram.js";
import { CursorRuntime } from "./runtimes/cursor.js";
import { ClaudeCodeRuntime } from "./runtimes/claude-code.js";
import { CodexRuntime } from "./runtimes/codex.js";
import { FleetManager, FleetEventBus } from "./fleet/index.js";
import { loadWorkspaces as loadWorkspacesFromState } from "./fleet/state.js";
import type { WorkspaceEntry } from "./fleet/index.js";
import { syncRules } from "./rules-sync.js";
import { startServer } from "./server/index.js";
import { setupInlineButtons } from "./transports/telegram-buttons.js";
import type { Runtime } from "./runtimes/interface.js";
import { startDispatcher, getDispatcherConfig, DISPATCHER_AGENT_NAME } from "./fleet/dispatcher.js";
import { createPostReplyHook } from "./fleet/tools.js";
import { setupCommandRouter } from "./commands/telegram.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION: string = pkg.version;

const RESTART_DELAY_MS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createTransport(cfg: BridgeConfig) {
  switch (cfg.transport) {
    case "telegram":
      if (!cfg.telegram?.token) { console.error("[fatal] telegram.token is required"); process.exit(1); }
      return new TelegramTransport({ token: cfg.telegram.token, allowedChats: cfg.telegram.allowedChats });

    case "lark": {
      const { LarkTransport } = require("./transports/lark.js");
      if (!cfg.lark?.appId || !cfg.lark?.appSecret) { console.error("[fatal] lark credentials required"); process.exit(1); }
      return new LarkTransport({ appId: cfg.lark.appId, appSecret: cfg.lark.appSecret, allowedChats: cfg.lark.allowedChats });
    }

    case "discord": {
      const { DiscordTransport } = require("./transports/discord.js");
      if (!cfg.discord?.token) { console.error("[fatal] discord.token is required"); process.exit(1); }
      return new DiscordTransport({ token: cfg.discord.token, allowedUsers: cfg.discord.allowedUsers });
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
        model: agent.model, permissionMode: agent.permissionMode,
        allowedTools: agent.allowedTools, disallowedTools: agent.disallowedTools,
      });
    case "codex":
      return new CodexRuntime({ model: agent.model, approvalPolicy: agent.approvalPolicy });
    default:
      console.error(`[fatal] unsupported runtime: ${agent.runtime}`);
      process.exit(1);
  }
}

async function ensureRulesSync(agentDef: AgentDef, workspace: string) {
  if (agentDef.runtime === "claude-code" || agentDef.runtime === "codex") {
    try { await syncRules(workspace, agentDef.runtime); }
    catch (err) { console.warn(`[rules-sync] ${agentDef.runtime}: ${(err as Error).message}`); }
  }
}

async function main() {
  const config = loadConfig();

  if (!config.agents.length) {
    console.error("[fatal] no agents configured");
    process.exit(1);
  }

  const transport = createTransport(config);
  const bus = new FleetEventBus();

  const workspaces = loadWorkspacesFromState();
  if (!workspaces.find((w) => w.path === config.workspace)) {
    workspaces.push({ alias: "cwd", path: config.workspace });
  }

  const fleet = new FleetManager(bus, {
    workspaces,
    createRuntime: (agentDef: AgentDef) => createRuntime(agentDef),
    ensureRulesSync: (agentDef: AgentDef) => ensureRulesSync(agentDef, config.workspace),
    getAgentDef: (runtime: RuntimeType, model?: string) => {
      const match = config.agents.find((a) => a.runtime === runtime);
      if (match) return model ? { ...match, model } : match;
      return { name: runtime, runtime, apiKey: "", model: model || "claude-sonnet-4-6" };
    },
    commsMode: config.fleet.comms,
    timeouts: config.fleet.timeouts,
  });

  await fleet.restore();
  fleet.setPostReplyHook(createPostReplyHook(fleet, workspaces, config.fleet.comms));

  // Wire command router (handles all Telegram commands + @mentions + routing)
  const { getNotifyChatId } = setupCommandRouter({
    fleet, bus, transport, config, workspaces, version: VERSION,
  });

  // Inter-agent notification callbacks — respect visibility config
  const visibility = config.fleet.visibility;

  fleet.onPeerMessage((from, to, direction) => {
    if (visibility.interAgent === "off") return;
    const chatId = getNotifyChatId();
    if (!chatId) return;
    if (visibility.interAgent === "summary") {
      const label = direction === "sent" ? "📤" : "📥";
      // Include content preview for sent messages
      const agent = fleet.getAgent(from);
      const preview = agent?.lastAgentMessage
        ? `: ${agent.lastAgentMessage.slice(0, 100)}${agent.lastAgentMessage.length > 100 ? "…" : ""}`
        : "";
      transport.sendReply(chatId, `${label} ${from} → ${to}${direction === "sent" ? preview : ""}`).catch(() => {});
    }
  });

  // Wire onReplyRouted — shows actual reply content when agents respond to each other
  fleet.onReplyRouted((fromAgent, toAgent, reply) => {
    if (visibility.interAgent === "off") return;
    const chatId = getNotifyChatId();
    if (!chatId) return;
    if (visibility.interAgent === "full") {
      const truncated = reply.length > 1500 ? reply.slice(0, 1500) + "…" : reply;
      transport.sendReply(chatId, `[${fromAgent} → ${toAgent}]\n${truncated}`).catch(() => {});
    }
    // summary mode previews are handled by onPeerMessage
  });

  fleet.onDispatcherBroadcast((reply, fromAgent) => {
    if (visibility.interAgent === "off") return;
    const chatId = getNotifyChatId();
    if (!chatId) return;
    if (visibility.interAgent === "full") {
      const truncated = reply.length > 1500 ? reply.slice(0, 1500) + "…" : reply;
      transport.sendReply(chatId, `[dispatcher · re:${fromAgent}]\n${truncated}`).catch(() => {});
    }
  });

  // Task completion notifications — only in "full" visibility mode
  // In "summary" mode, onPeerMessage already covers completions via "📤 agent → dispatcher" previews
  bus.onEvent((event) => {
    if (event.type !== "status_change") return;
    if (visibility.interAgent !== "full") return;
    const chatId = getNotifyChatId();
    if (!chatId) return;
    const payload = event.payload as { status?: string } | undefined;
    if (!payload) return;

    if (payload.status === "waiting" && event.agentName !== DISPATCHER_AGENT_NAME) {
      const agent = fleet.getAgent(event.agentName);
      const lastTask = agent?.lastUserMessage?.slice(0, 80) || "task";
      transport.sendReply(chatId, `✅ ${event.agentName} finished: ${lastTask}`).catch(() => {});
    }
  });

  // Start dispatcher + server
  const dispatcherConfig = getDispatcherConfig(config);
  await startDispatcher(fleet, bus, config, workspaces);
  const { port } = startServer(fleet, bus, config, workspaces);

  // Event logging
  bus.onEvent((event) => {
    const detail = event.payload ? ` ${JSON.stringify(event.payload).slice(0, 80)}` : "";
    console.log(`[fleet] ${event.type} agent=${event.agentName} session=${event.sessionId.slice(0, 12)}${detail}`);
  });

  await transport.start();

  if (transport instanceof TelegramTransport) {
    const bot = transport.getBot();
    if (bot) setupInlineButtons(bot, fleet, config, workspaces);
  }

  console.log(`\nThronglets v${VERSION}`);
  console.log(`  Transport:   ${transport.name}`);
  console.log(`  API:         http://127.0.0.1:${port}`);
  console.log(`  WebSocket:   ws://127.0.0.1:${port}/ws`);
  console.log(`  Workspaces:  ${workspaces.map((w) => `${w.alias}→${w.path.split("/").pop()}`).join(", ")}`);
  console.log(`  Runtimes:    ${config.agents.map((a) => `${a.name}(${a.runtime})`).join(", ")}`);
  console.log(`  Fleet:       ${fleet.listAgents().length} restored`);
  console.log(`  Comms:       ${config.fleet.comms} (inter-agent: ${config.fleet.visibility.interAgent})`);
  console.log(`\n  Commands: /hatch /kill /fleet /clear /change /status /help`);
  console.log(`  Mention:  @name message | @all message\n`);

  // Dispatcher auto-recovery + idle-fleet poke heartbeat
  let dispatcherRecovering = false;
  let lastIdlePoke = 0;
  const IDLE_POKE_ENABLED = false;
  const IDLE_POKE_DEBOUNCE_MS = 10 * 60 * 1000;
  setInterval(async () => {
    const s = fleet.getStatus();
    const nonDispatcher = s.agents.filter((a) => a.name !== DISPATCHER_AGENT_NAME);
    console.log(`[heartbeat] ${new Date().toISOString()} fleet=${s.total} working=${s.working} dead=${s.dead}`);

    if (dispatcherConfig.enabled && !dispatcherRecovering) {
      const disp = fleet.getAgent(DISPATCHER_AGENT_NAME);
      if (!disp) {
        // Dispatcher was never spawned (missing from state) — start fresh
        dispatcherRecovering = true;
        console.log(`[heartbeat] dispatcher absent — starting fresh...`);
        try {
          const ok = await startDispatcher(fleet, bus, config, workspaces);
          console.log(`[heartbeat] dispatcher start: ${ok ? "success" : "failed"}`);
          const chatId = getNotifyChatId();
          if (ok && chatId) {
            transport.sendReply(chatId, "🔄 Dispatcher started").catch(() => {});
          }
        } catch (e) {
          console.error(`[heartbeat] dispatcher start failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          dispatcherRecovering = false;
        }
      } else if (disp.status === "dead" || disp.status === "error") {
        // Dispatcher exists but crashed — respawn (preserve identity)
        dispatcherRecovering = true;
        console.log(`[heartbeat] dispatcher is ${disp.status} — respawning (preserving identity)...`);
        try {
          const result = await fleet.respawn(DISPATCHER_AGENT_NAME);
          console.log(`[heartbeat] dispatcher respawn: ${result}`);
          const chatId = getNotifyChatId();
          if (chatId) {
            transport.sendReply(chatId, "🔄 Dispatcher respawned (identity preserved)").catch(() => {});
          }
        } catch (e) {
          console.error(`[heartbeat] dispatcher respawn failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          dispatcherRecovering = false;
        }
      }

      // Idle-fleet poke: if all throngs are sleeping/dead, nudge dispatcher
      const allIdle = nonDispatcher.length > 0 &&
        nonDispatcher.every((a) => a.status === "sleeping" || a.status === "dead");
      const now = Date.now();
      if (IDLE_POKE_ENABLED && allIdle && !dispatcherRecovering && (now - lastIdlePoke) > IDLE_POKE_DEBOUNCE_MS) {
        const dispAgent = fleet.getAgent(DISPATCHER_AGENT_NAME);
        if (dispAgent && dispAgent.status !== "working") {
          lastIdlePoke = now;
          const goal = fleet.getGoal();
          const msg = goal
            ? `[IDLE_POKE] All throngs are sleeping/dead. Goal: ${goal}\nReview what's stuck, decide whether to retry or report to user.`
            : `[IDLE_POKE] All throngs are sleeping/dead. No goal set. Ask the user what to do.`;
          console.log(`[heartbeat] all throngs idle — poking dispatcher`);
          fleet.send(DISPATCHER_AGENT_NAME, msg, "system").catch((e) => {
            console.warn(`[heartbeat] idle poke failed: ${e instanceof Error ? e.message : e}`);
          });
        }
      }
    }
  }, 2 * 60 * 1000);
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

process.on("SIGINT", () => { console.log("\nShutting down..."); process.exit(0); });
process.on("uncaughtException", (err) => { console.error(`[uncaught] ${err.message}`); console.error(err.stack); });
process.on("unhandledRejection", (reason) => { console.error(`[unhandled-rejection] ${reason}`); });
