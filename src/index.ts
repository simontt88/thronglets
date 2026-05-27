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
import { createServerApp, listenServer } from "./server/index.js";
import { setReloadCallback, setPromoteCallback } from "./server/http.js";
import { setupInlineButtons } from "./transports/telegram-buttons.js";
import type { Runtime } from "./runtimes/interface.js";
import { startDispatcher, getDispatcherConfig, DISPATCHER_AGENT_NAME } from "./fleet/dispatcher.js";
import { createPostReplyHook } from "./fleet/tools.js";
import { setupCommandRouter } from "./commands/telegram.js";
import { NotificationThrottle } from "./notifications.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import type { Server as HttpServer } from "http";
import type { Transport } from "./transports/interface.js";
import { GLOBAL_CONFIG_DIR } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION: string = pkg.version;

const RESTART_DELAY_MS = 10000;
const RELOAD_HEALTH_TIMEOUT_MS = 15_000;
const RELOAD_LOG_FILE = join(GLOBAL_CONFIG_DIR, "reload.log");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function reloadLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { writeFileSync(RELOAD_LOG_FILE, line, { flag: "a" }); } catch {}
  console.log(`[reload] ${msg}`);
}

// ─── Graceful Shutdown ───

let _httpServer: HttpServer | null = null;
let _transport: Transport | null = null;
let _fleet: FleetManager | null = null;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _shuttingDown = false;

async function gracefulShutdown(reason: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[shutdown] initiated — ${reason}`);

  if (_heartbeatTimer) clearInterval(_heartbeatTimer);

  if (_fleet) {
    try { await _fleet.gracefulShutdown(); }
    catch (e) { console.warn(`[shutdown] fleet error: ${(e as Error).message}`); }
  }

  if (_transport) {
    try { await _transport.stop(); }
    catch (e) { console.warn(`[shutdown] transport error: ${(e as Error).message}`); }
  }

  if (_httpServer) {
    await new Promise<void>((resolve) => {
      _httpServer!.close(() => resolve());
      setTimeout(resolve, 5000);
    });
    console.log(`[shutdown] HTTP server closed`);
  }

  console.log(`[shutdown] complete`);
}

// ─── Hot-Reload ───

function triggerReload(): void {
  reloadLog(`reload triggered (pid=${process.pid})`);

  const scriptPath = join(__dirname, "../scripts/reload.sh");
  if (!existsSync(scriptPath)) {
    reloadLog(`ERROR: reload script not found at ${scriptPath}`);
    return;
  }

  const port = process.env.BRIDGE_PORT || "3847";
  const child = spawn("bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      RELOAD_OLD_PID: String(process.pid),
      RELOAD_PORT: port,
      RELOAD_CWD: process.cwd(),
      RELOAD_LOG: RELOAD_LOG_FILE,
    },
  });
  child.unref();
  reloadLog(`reload script spawned (orchestrator pid=${child.pid})`);
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
      return new CodexRuntime({ model: agent.model, apiKey: agent.apiKey, approvalPolicy: agent.approvalPolicy });
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
      const defaultModels: Record<string, string> = {
        cursor: "claude-sonnet-4-6",
        "claude-code": "claude-sonnet-4-6",
        codex: "o4-mini",
      };
      return { name: runtime, runtime, apiKey: "", model: model || defaultModels[runtime] || "claude-sonnet-4-6" };
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

  // Fleet activity notifications — platform-level status feed
  fleet.onFleetActivity((event) => {
    console.log(`[lifecycle] ${event.type} agent=${event.agent}`);
    if (!visibility.lifecycle) return;
    const chatId = getNotifyChatId();
    if (!chatId) return;

    const formatElapsed = (ms: number | null | undefined): string => {
      if (!ms) return "";
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
      return `${Math.round(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
    };

    switch (event.type) {
      case "agent_waking": {
        const from = event.detail.from as string;
        const task = event.detail.task as string;
        transport.sendReply(chatId, `🔄 ${event.agent}: sleeping → working\n   ← ${from}: "${task}"`).catch(() => {});
        break;
      }
      case "agent_completed": {
        const elapsed = formatElapsed(event.detail.elapsedMs as number | null);
        const preview = event.detail.replyPreview as string || "";
        const elapsedStr = elapsed ? ` (${elapsed})` : "";
        const previewStr = preview ? `\n   "${preview.slice(0, 100)}"` : "";
        transport.sendReply(chatId, `✅ ${event.agent}: done${elapsedStr}${previewStr}`).catch(() => {});
        break;
      }
      case "agent_died": {
        const error = (event.detail.error as string) || "unknown error";
        transport.sendReply(chatId, `❌ ${event.agent}: error — ${error}`).catch(() => {});
        break;
      }
      case "agent_timeout": {
        const attempts = event.detail.attempts as number || 0;
        transport.sendReply(chatId, `⏱ ${event.agent}: timed out${attempts > 1 ? ` (${attempts} attempts)` : ""}`).catch(() => {});
        break;
      }
      case "send_failed": {
        const from = event.detail.from as string;
        const error = (event.detail.error as string) || "unknown";
        transport.sendReply(chatId, `⚠️ Failed to reach ${event.agent} (from ${from}): ${error}`).catch(() => {});
        break;
      }
      // send_success is implicit — the agent_waking event already tells the user
      default:
        break;
    }
  });

  // Notification throttle for dispatcher→user messages
  const notifThrottle = new NotificationThrottle(config.fleet.notificationCooldownMs);

  fleet.onUserNotification((text, level) => {
    const chatId = getNotifyChatId();
    if (!chatId) return;
    if (level === "critical" || notifThrottle.shouldSend("dispatcher-notify", level as "info", text)) {
      transport.sendReply(chatId, text).catch(() => {});
    }
  });

  // Start dispatcher + server
  const dispatcherConfig = getDispatcherConfig(config);

  setReloadCallback(triggerReload);

  const realPort = parseInt(process.env.BRIDGE_PORT || "") || 3847;
  const port = realPort;
  const app = createServerApp(fleet, config);

  // Event logging
  bus.onEvent((event) => {
    const detail = event.payload ? ` ${JSON.stringify(event.payload).slice(0, 80)}` : "";
    console.log(`[fleet] ${event.type} agent=${event.agentName} session=${event.sessionId.slice(0, 12)}${detail}`);
  });

  // goLive: bind the real port + start dispatcher + Telegram polling.
  // Called immediately on a normal launch, or via /promote after a standby boot.
  let _live = false;
  const goLive = async (): Promise<void> => {
    if (_live) return;
    await startDispatcher(fleet, bus, config, workspaces);
    let liveServer: HttpServer | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 15 && !liveServer; attempt++) {
      try {
        const s = listenServer(app, fleet, bus, config, workspaces, realPort);
        await new Promise<void>((resolve, reject) => {
          s.once("listening", () => resolve());
          s.once("error", (e) => reject(e));
          if (s.listening) resolve();
          setTimeout(() => reject(new Error("listen timeout")), 2000);
        });
        liveServer = s;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        await sleep(400);
      }
    }
    if (!liveServer) throw new Error(`bind :${realPort} failed after retries: ${lastErr}`);
    _httpServer = liveServer;
    await transport.start();
    if (transport instanceof TelegramTransport) {
      const bot = transport.getBot();
      if (bot) setupInlineButtons(bot, fleet, config, workspaces);
    }
    _live = true;
    reloadLog(`live on :${realPort} (telegram polling started)`);
  };

  _transport = transport;
  _fleet = fleet;

  const standbyPortRaw = process.env.RELOAD_STANDBY_PORT;
  if (standbyPortRaw) {
    // Standby boot: validate THIS process without disturbing the live server.
    const standbyPort = parseInt(standbyPortRaw, 10);
    const standbyServer = listenServer(app, fleet, bus, config, workspaces, standbyPort);
    _httpServer = standbyServer;
    reloadLog(`standby: HTTP on :${standbyPort}, telegram OFF, awaiting /promote`);
    console.log(`[standby] booted on :${standbyPort} (fleet ${fleet.listAgents().length}), telegram OFF, awaiting /promote`);
    setPromoteCallback(async () => {
      try {
        await goLive();
        try { standbyServer.close(); } catch {}
        reloadLog(`promoted: live on :${realPort}, standby :${standbyPort} closed`);
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reloadLog(`promote FAILED: ${msg}`);
        return { ok: false, error: msg };
      }
    });
  } else {
    await goLive();
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

  // Dispatcher auto-recovery + smart IDLE_POKE heartbeat
  let dispatcherRecovering = false;
  let lastIdlePoke = 0;
  let idlePokeCount = 0;
  let lastUserActivity = Date.now();
  const pokeConfig = config.fleet.idlePoke;
  const digestConfig = config.fleet.digest;

  // Track user activity for digest timer
  bus.onEvent((event) => {
    if (event.type === "user_message") {
      lastUserActivity = Date.now();
      idlePokeCount = 0;
      notifThrottle.resetAll();
    }
  });

  _heartbeatTimer = setInterval(async () => {
    const s = fleet.getStatus();
    const nonDispatcher = s.agents.filter((a) => a.name !== DISPATCHER_AGENT_NAME);
    console.log(`[heartbeat] ${new Date().toISOString()} fleet=${s.total} working=${s.working} dead=${s.dead}`);

    if (dispatcherConfig.enabled && !dispatcherRecovering) {
      const disp = fleet.getAgent(DISPATCHER_AGENT_NAME);
      if (!disp) {
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

      // Smart IDLE_POKE: config-driven, debounced, capped, with task ledger context
      const allIdle = nonDispatcher.length > 0 &&
        nonDispatcher.every((a) => a.status === "sleeping" || a.status === "dead" || a.status === "waiting");
      const now = Date.now();
      if (pokeConfig.enabled && allIdle && !dispatcherRecovering && (now - lastIdlePoke) > pokeConfig.debounceMs) {
        const dispAgent = fleet.getAgent(DISPATCHER_AGENT_NAME);
        if (dispAgent && dispAgent.status !== "working" && idlePokeCount < pokeConfig.maxPerCycle) {
          lastIdlePoke = now;
          idlePokeCount++;
          const goal = fleet.getGoal();
          const taskSummary = fleet.getTaskLedgerSummary();
          const parts = [`[IDLE_POKE ${idlePokeCount}/${pokeConfig.maxPerCycle}] All throngs idle.`];
          if (goal) parts.push(`Goal: ${goal}`);
          if (taskSummary) parts.push(`Recent tasks: ${taskSummary}`);
          parts.push(`Review task log with [FLEET:fleet_task_log:{}], then assign new work or notify user of progress.`);
          const msg = parts.join("\n");
          console.log(`[heartbeat] all throngs idle — poking dispatcher (${idlePokeCount}/${pokeConfig.maxPerCycle})`);
          fleet.send(DISPATCHER_AGENT_NAME, msg, "system").catch((e) => {
            console.warn(`[heartbeat] idle poke failed: ${e instanceof Error ? e.message : e}`);
          });
        }
      }

      // Progress digest: auto-summary after sustained user silence
      if (digestConfig.enabled && (now - lastUserActivity) > digestConfig.silenceThresholdMs) {
        if (notifThrottle.shouldSend("digest", "info", "auto-digest")) {
          const taskSummary = fleet.getTaskLedgerSummary();
          const chatId = getNotifyChatId();
          if (chatId && taskSummary) {
            const digestMsg = `📊 Fleet digest (${Math.round((now - lastUserActivity) / 3600_000)}h since last message):\n${taskSummary}`;
            transport.sendReply(chatId, digestMsg).catch(() => {});
            console.log(`[heartbeat] sent progress digest to user`);
          }
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

process.on("SIGINT", async () => {
  await gracefulShutdown("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await gracefulShutdown("SIGTERM");
  process.exit(0);
});

process.on("SIGUSR2", () => {
  reloadLog("SIGUSR2 received — initiating hot-reload");
  triggerReload();
});

process.on("uncaughtException", (err) => { console.error(`[uncaught] ${err.message}`); console.error(err.stack); });
process.on("unhandledRejection", (reason) => { console.error(`[unhandled-rejection] ${reason}`); });
