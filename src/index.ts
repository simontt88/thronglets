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
import { setupInlineButtons, sendNewPrompt, sendChangePrompt, sendKillPrompt, sendClearPrompt } from "./transports/telegram-buttons.js";
import type { Transport } from "./transports/interface.js";
import type { Runtime } from "./runtimes/interface.js";
import { startDispatcher, getDispatcherConfig, DISPATCHER_AGENT_NAME } from "./fleet/dispatcher.js";
import { createPostReplyHook } from "./fleet/tools.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION: string = pkg.version;

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
  return loadWorkspacesFromState();
}

const DISPATCHER_ALIASES = new Set(["D", "d", "dispatch", "dispatcher", "orix"]);

function resolveDispatcherAlias(mention: string): string {
  return DISPATCHER_ALIASES.has(mention) ? "_dispatcher" : mention;
}

function parseAtMentions(text: string): { mentions: string[]; body: string } {
  const mentionRegex = /^(@\w+\s*)+/;
  const match = text.match(mentionRegex);
  if (!match) return { mentions: [], body: text };

  const mentionStr = match[0];
  const body = text.slice(mentionStr.length).trim();
  const mentions = [...mentionStr.matchAll(/@(\w+)/g)].map((m) => resolveDispatcherAlias(m[1]));
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

  // Wire fleet tools post-reply hook
  fleet.setPostReplyHook(createPostReplyHook(fleet, workspaces));

  // Track last active chat for user-facing replies
  let notifyChatId: string | null = null;

  // Start dispatcher (if enabled in config)
  const dispatcherConfig = getDispatcherConfig(config);
  await startDispatcher(fleet, bus, config, workspaces);

  // Start HTTP + WebSocket server
  const { port } = startServer(fleet, bus, config, workspaces);

  // Log all events
  bus.onEvent((event) => {
    const detail = event.payload ? ` ${JSON.stringify(event.payload).slice(0, 80)}` : "";
    console.log(`[fleet] ${event.type} agent=${event.agentName} session=${event.sessionId.slice(0, 12)}${detail}`);
  });

  transport.onMessage(async (msg) => {
    const { chatId, text } = msg;
    // Track last active chat for inter-agent notifications
    notifyChatId = chatId;

    // ── Command handling ──────────────────────────────────────
    if (msg.isCommand) {
      const parts = text.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      switch (cmd) {
        case "/start": {
          const runtimes = config.agents.map((a) => `  • ${a.runtime} — ${a.model}`).join("\n");
          const wsList = workspaces.map((w) => `  • ${w.alias} — .../${w.path.split("/").pop()}`).join("\n");
          const currentFleet = fleet.listAgents();
          const fleetLine = currentFleet.length
            ? `\nActive agents: ${currentFleet.join(", ")}\nSend messages directly or use @name prefix.`
            : "\nNo agents running yet. Spawn one to get started:";
          const welcome = [
            `🐣 Thronglets v${VERSION}`,
            "",
            "Your thronglet fleet — each creature runs in a workspace with full coding powers.",
            "",
            "💬 How to talk:",
            "  Just type — dispatcher routes it for you",
            "  @name msg — send directly to a thronglet",
            "  @all msg — broadcast to all",
            "",
            "📋 Commands:",
            "  /new [name] [runtime] [workspace] — hatch a thronglet",
            "  /kill <name> — release a thronglet",
            "  /fleet — list all thronglets + status",
            "  /clear <name> — fresh session",
            "  /title <name> <title> — set title",
            "  /change <name> <field> <value> — reconfigure",
            "  /dispatcher [restart] — dispatcher info / restart",
            "",
            `⚙️ Runtimes:\n${runtimes}`,
            `📁 Workspaces:\n${wsList}`,
            fleetLine,
          ].join("\n");
          await transport.sendReply(chatId, welcome);
          return;
        }

        case "/new": {
          const [name, runtime, workspace] = args;
          if (!name && transport instanceof TelegramTransport && transport.getBot()) {
            sendNewPrompt(transport.getBot()!, chatId);
            return;
          }
          const rt = (runtime || config.agents[0]?.runtime || "cursor") as RuntimeType;
          const ws = workspace || cwdAlias?.alias || workspaces[0]?.alias || "cwd";
          const result = await fleet.spawn(name || undefined, rt, ws);
          await transport.sendReply(chatId, result);
          return;
        }

        case "/kill": {
          const name = args[0];
          if (!name && transport instanceof TelegramTransport && transport.getBot()) {
            sendKillPrompt(transport.getBot()!, chatId);
            return;
          }
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
          if (!name && transport instanceof TelegramTransport && transport.getBot()) {
            sendClearPrompt(transport.getBot()!, chatId);
            return;
          }
          if (!name) {
            await transport.sendReply(chatId, "Usage: /clear <name>");
            return;
          }
          const result = await fleet.clear(name);
          await transport.sendReply(chatId, result);
          return;
        }

        case "/change": {
          const [name, field, value] = args;
          if ((!name || !field || !value) && transport instanceof TelegramTransport && transport.getBot()) {
            sendChangePrompt(transport.getBot()!, chatId);
            return;
          }
          if (!name || !field || !value) {
            await transport.sendReply(chatId, "Usage: /change <name> <model|workspace|runtime> <value>\n\nExamples:\n  /change Noxmi model claude-sonnet-4-6\n  /change Noxmi workspace vb\n  /change Noxmi runtime claude-code");
            return;
          }
          const changeResult = await fleet.change(name, field, value, config, workspaces);
          await transport.sendReply(chatId, changeResult);
          return;
        }

        case "/fleet": {
          const status = fleet.getStatus();
          const thronglets = status.agents.filter((a) => a.name !== "_dispatcher");
          if (thronglets.length === 0) {
            await transport.sendReply(chatId, "No thronglets running.\nHatch one: /new [runtime] [workspace]");
            return;
          }
          const lines = thronglets.map((a) => {
            const dot = a.status === "working" ? "🟢"
              : a.status === "error" ? "🔴"
              : a.status === "dead" ? "💀"
              : a.status === "idle" ? "⚪"
              : "⚫";
            const titleStr = a.title ? ` — ${a.title}` : "";
            const ago = timeSince(a.lastActivity);
            const activity = a.inferred && a.status === "working"
              ? a.inferred.replace("processing message from ", "← ")
              : a.sessionName || "";
            const actStr = activity ? `  _${activity}_` : "";
            return `${dot} *${a.name}*${titleStr}\n    ${a.runtime} · ${a.workspace} · ${ago}${actStr}`;
          });

          const working = thronglets.filter((a) => a.status === "working").length;
          const idle = thronglets.filter((a) => a.status === "idle").length;
          const dead = thronglets.filter((a) => a.status === "dead" || a.status === "stopped").length;
          const errored = thronglets.filter((a) => a.status === "error").length;
          const parts = [`${working} working`, `${idle} idle`];
          if (dead) parts.push(`${dead} dead`);
          if (errored) parts.push(`${errored} error`);

          const dispatcher = fleet.getAgent("_dispatcher");
          const dispLine = dispatcher
            ? `\n🔮 *Dispatcher* (Orix): ${dispatcher.status} · ${timeSince(dispatcher.lastActivity)}`
            : "\n⚠️ Dispatcher: offline";

          const header = `Fleet: ${thronglets.length} thronglets (${parts.join(", ")})`;
          await transport.sendReply(chatId, `${header}\n\n${lines.join("\n\n")}${dispLine}`);
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
              `*${agent.name}*${agent.title ? ` — ${agent.title}` : ""}`,
              `Runtime: ${agent.runtime}`,
              `Model: ${agent.model}`,
              `Workspace: ${agent.workspace} (${agent.workspacePath})`,
              `Status: ${agent.status}`,
              `Last active: ${timeSince(agent.lastActivity)}`,
              `Session: ${agent.currentSessionId}${agent.sessionName ? ` 「${agent.sessionName}」` : ""}`,
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

        case "/dispatcher": {
          const sub = args[0];
          const dispatcherAgent = fleet.getAgent(DISPATCHER_AGENT_NAME);

          if (sub === "restart" || sub === "reset") {
            if (dispatcherAgent) await fleet.kill(DISPATCHER_AGENT_NAME);
            const ok = await startDispatcher(fleet, bus, config, workspaces);
            await transport.sendReply(chatId, ok ? "✅ Dispatcher restarted." : "❌ Dispatcher failed to start.");
            return;
          }

          if (!dispatcherAgent) {
            await transport.sendReply(chatId, "⚠️ Dispatcher is offline.\nUse /dispatcher restart to bring it back.");
            return;
          }

          const lines = [
            `🔮 *Dispatcher* (Orix)`,
            `Status: ${dispatcherAgent.status}`,
            `Last active: ${timeSince(dispatcherAgent.lastActivity)}`,
            `Session: ${dispatcherAgent.currentSessionId}`,
            `Messages: ${dispatcherAgent.messageCount}`,
            "",
            `Use /dispatcher restart to force-restart.`,
          ];
          await transport.sendReply(chatId, lines.join("\n"));
          return;
        }

        case "/title": {
          const tName = args[0];
          const tTitle = args.slice(1).join(" ");
          if (!tName) {
            await transport.sendReply(chatId, "Usage: /title <name> <title>\nExample: /title Felta QA master");
            return;
          }
          if (!fleet.hasAgent(tName)) {
            await transport.sendReply(chatId, `Agent "${tName}" not found.`);
            return;
          }
          const titleResult = fleet.setTitle(tName, tTitle);
          await transport.sendReply(chatId, titleResult);
          return;
        }

        case "/workspace": {
          const sub = args[0];
          if (sub === "add") {
            const wAlias = args[1];
            const wPath = args[2];
            if (!wAlias || !wPath) {
              await transport.sendReply(chatId, "Usage: /workspace add <alias> <path>\nExample: /workspace add myrepo /home/user/repos/myrepo");
              return;
            }
            const addResult = fleet.addWorkspace(wAlias, wPath);
            await transport.sendReply(chatId, addResult);
            return;
          }
          // Default: list workspaces
          const wsList = workspaces.map((w) => `  • ${w.alias} — ${w.path}`).join("\n");
          await transport.sendReply(chatId, `Workspaces:\n${wsList || "  (none)"}`);
          return;
        }

        case "/help":
          await transport.sendReply(chatId, [
            "💬 Just type — dispatcher handles routing",
            "  @name msg — send to a specific thronglet",
            "  @all msg — broadcast to all",
            "",
            "📋 Commands:",
            "  /new [name] [runtime] [workspace] — hatch",
            "  /kill <name> — release",
            "  /fleet — list all + status",
            "  /clear <name> — fresh session",
            "  /title <name> <title> — set title",
            "  /change <name> <field> <value> — reconfigure",
            "  /status [name] — detail",
            "  /dispatcher [restart] — dispatcher info",
            "  /workspace [add alias path] — manage workspaces",
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
          await transport.sendReply(chatId, `[${target} \u00B7 ${elapsed}s]\n${reply}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          await transport.sendReply(chatId, `[${target} \u00B7 ${elapsed}s \u00B7 error]\n${errMsg.slice(0, 500)}`);
        }
      }
      return;
    }

    // ── No @mention: route to single agent, dispatcher, or prompt user ──
    const agentList = fleet.listAgents().filter((n) => n !== DISPATCHER_AGENT_NAME);
    if (agentList.length === 1 && !dispatcherConfig.enabled) {
      // Single agent, no dispatcher — direct send
      const target = agentList[0];
      await transport.sendTyping(chatId);
      const typingInterval = setInterval(() => { transport.sendTyping(chatId).catch(() => {}); }, 4000);
      const startTime = Date.now();
      try {
        const reply = await fleet.send(target, text);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        await transport.sendReply(chatId, `[${target} · ${elapsed}s]\n${reply}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        await transport.sendReply(chatId, `[${target} · ${elapsed}s · error]\n${errMsg.slice(0, 500)}`);
      } finally {
        clearInterval(typingInterval);
      }
    } else if (agentList.length === 0 && !fleet.hasAgent(DISPATCHER_AGENT_NAME)) {
      await transport.sendReply(chatId, "No thronglets running.\n\nHatch one: /new [runtime] [workspace]");
    } else if (dispatcherConfig.enabled) {
      // Dispatcher enabled — check health & auto-recover if needed
      const dispatcherAgent = fleet.getAgent(DISPATCHER_AGENT_NAME);
      if (!dispatcherAgent || dispatcherAgent.status === "dead" || dispatcherAgent.status === "error") {
        await transport.sendReply(chatId, "🔄 Dispatcher is down — restarting...");
        if (dispatcherAgent) await fleet.kill(DISPATCHER_AGENT_NAME);
        const restarted = await startDispatcher(fleet, bus, config, workspaces);
        if (!restarted) {
          await transport.sendReply(chatId, "❌ Dispatcher failed to restart. Use @name to talk to a thronglet directly.");
          return;
        }
        await transport.sendReply(chatId, "✅ Dispatcher recovered. Routing your message now...");
      }

      await transport.sendTyping(chatId);
      const typingInterval = setInterval(() => { transport.sendTyping(chatId).catch(() => {}); }, 4000);
      const startTime = Date.now();
      try {
        const reply = await fleet.send(DISPATCHER_AGENT_NAME, text);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        await transport.sendReply(chatId, `[dispatcher · ${elapsed}s]\n${reply}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        await transport.sendReply(chatId, `[dispatcher · ${elapsed}s · error]\n${errMsg.slice(0, 500)}`);
      } finally {
        clearInterval(typingInterval);
      }
    } else {
      await transport.sendReply(chatId, `Multiple agents running. Use @name to address one:\n${agentList.map((n) => `  @${n}`).join("\n")}\n  @all (broadcast)`);
    }
  });

  await transport.start();

  // Setup inline buttons if using Telegram
  if (transport instanceof TelegramTransport) {
    const bot = transport.getBot();
    if (bot) {
      setupInlineButtons(bot, fleet, config, workspaces);
    }
  }

  console.log(`\nThronglets v${VERSION}`);
  console.log(`  Transport:   ${transport.name}`);
  console.log(`  API:         http://127.0.0.1:${port}`);
  console.log(`  WebSocket:   ws://127.0.0.1:${port}/ws`);
  console.log(`  Workspaces:  ${workspaces.map((w) => `${w.alias}→${w.path.split("/").pop()}`).join(", ")}`);
  console.log(`  Runtimes:    ${config.agents.map((a) => `${a.name}(${a.runtime})`).join(", ")}`);
  console.log(`  Fleet:       ${fleet.listAgents().length} restored`);
  console.log(`\n  Commands: /new /kill /fleet /clear /change /status /help`);
  console.log(`  Mention:  @name message | @all message\n`);

  setInterval(async () => {
    const s = fleet.getStatus();
    console.log(`[heartbeat] ${new Date().toISOString()} fleet=${s.total} working=${s.working} dead=${s.dead}`);

    // Auto-recover dispatcher if it died
    if (dispatcherConfig.enabled) {
      const disp = fleet.getAgent(DISPATCHER_AGENT_NAME);
      if (!disp || disp.status === "dead") {
        console.log("[heartbeat] dispatcher is dead — auto-recovering...");
        if (disp) await fleet.kill(DISPATCHER_AGENT_NAME);
        const ok = await startDispatcher(fleet, bus, config, workspaces);
        console.log(`[heartbeat] dispatcher recovery: ${ok ? "success" : "failed"}`);
      }
    }
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
