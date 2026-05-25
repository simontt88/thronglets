import type { FleetManager, FleetEventBus, WorkspaceEntry } from "../fleet/index.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import type { Transport } from "../transports/interface.js";
import { TelegramTransport } from "../transports/telegram.js";
import { startDispatcher, getDispatcherConfig, DISPATCHER_AGENT_NAME } from "../fleet/dispatcher.js";
import { sendNewPrompt, sendChangePrompt, sendKillPrompt, sendClearPrompt } from "../transports/telegram-buttons.js";
import { POKE_MESSAGE_WITH_GOAL, POKE_MESSAGE_NO_GOAL } from "../utils/constants.js";

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

function timeSince(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}

interface CommandRouterDeps {
  fleet: FleetManager;
  bus: FleetEventBus;
  transport: Transport;
  config: BridgeConfig;
  workspaces: WorkspaceEntry[];
  version: string;
}

/**
 * Wire up Telegram message handling: commands, @mentions, and dispatcher routing.
 * Returns a reference to notifyChatId for inter-agent notifications.
 */
export function setupCommandRouter(deps: CommandRouterDeps): { getNotifyChatId: () => string | null } {
  const { fleet, bus, transport, config, workspaces, version } = deps;
  const dispatcherConfig = getDispatcherConfig(config);
  const cwdAlias = workspaces.find((w) => w.path === config.workspace);

  // Seed from config so lifecycle notifications work before the first user message
  const transportConfig = config.telegram || config.lark;
  let notifyChatId: string | null = transportConfig?.allowedChats?.[0] ?? null;

  transport.onMessage(async (msg) => {
    const { chatId, text } = msg;
    notifyChatId = chatId;

    if (msg.isCommand) {
      await handleCommand(chatId, text, deps);
      return;
    }

    await handleMessage(chatId, text, deps, dispatcherConfig.enabled, cwdAlias);
  });

  return { getNotifyChatId: () => notifyChatId };
}

async function handleCommand(
  chatId: string,
  text: string,
  deps: CommandRouterDeps,
): Promise<void> {
  const { fleet, bus, transport, config, workspaces, version } = deps;
  const parts = text.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  const cwdAlias = workspaces.find((w) => w.path === config.workspace);

  switch (cmd) {
    case "/start": {
      const runtimes = config.agents.map((a) => `  • ${a.runtime} — ${a.model}`).join("\n");
      const wsList = workspaces.map((w) => `  • ${w.alias} — .../${w.path.split("/").pop()}`).join("\n");
      const currentFleet = fleet.listAgents();
      const fleetLine = currentFleet.length
        ? `\nActive agents: ${currentFleet.join(", ")}\nSend messages directly or use @name prefix.`
        : "\nNo agents running yet. Spawn one to get started:";
      const welcome = [
        `🐣 Thronglets v${version}`,
        "",
        "Your throng fleet — each creature runs in a workspace with full coding powers.",
        "",
        "💬 How to talk:",
        "  Just type — dispatcher routes it for you",
        "  @name msg — send directly to a throng",
        "  @all msg — broadcast to all",
        "",
        "📋 Commands:",
        "  /hatch [runtime] [workspace] — hatch a throng (auto-named)",
        "  /kill <name> — release a throng",
        "  /fleet — list all throngs + status",
        "  /clear <name> — fresh session",
        "  /title <name> <title> — set title",
        "  /change <name> <field> <value> — reconfigure",
        "  /poke — nudge dispatcher to assign work",
        "  /goal [text] — view or set fleet goal",
        "  /dispatcher [restart] — dispatcher info / restart",
        "",
        `⚙️ Runtimes:\n${runtimes}`,
        `📁 Workspaces:\n${wsList}`,
        fleetLine,
      ].join("\n");
      await transport.sendReply(chatId, welcome);
      return;
    }

    case "/hatch":
    case "/new": {
      const [runtimeArg, workspace] = args;
      if (!runtimeArg && transport instanceof TelegramTransport && transport.getBot()) {
        sendNewPrompt(transport.getBot()!, chatId);
        return;
      }
      const rt = (runtimeArg || config.agents[0]?.runtime || "cursor") as RuntimeType;
      const ws = workspace || cwdAlias?.alias || workspaces[0]?.alias || "cwd";
      const result = await fleet.spawn(undefined, rt, ws);
      await transport.sendReply(chatId, result);
      return;
    }

    case "/kill": {
      const name = args[0];
      if (!name && transport instanceof TelegramTransport && transport.getBot()) {
        sendKillPrompt(transport.getBot()!, chatId);
        return;
      }
      if (!name) { await transport.sendReply(chatId, "Usage: /kill <name>"); return; }
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
      if (!name) { await transport.sendReply(chatId, "Usage: /clear <name>"); return; }
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
        await transport.sendReply(chatId, "Usage: /change <name> <model|workspace|runtime> <value>");
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
        await transport.sendReply(chatId, "No throngs running.\nHatch one: /hatch [runtime] [workspace]");
        return;
      }

      const statusEmoji = (s: string) =>
        s === "working" ? "🔨" : s === "waiting" ? "👀" : s === "sleeping" ? "💤" : s === "dead" ? "☠️" : s === "error" ? "❌" : "⚫";

      const grouped = new Map<string, typeof thronglets>();
      for (const a of thronglets) {
        const key = a.workspace;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(a);
      }

      const sections: string[] = [];
      for (const [alias, agents] of grouped) {
        const dirName = agents[0].workspacePath.split("/").pop() || alias;
        const agentLines = agents.map((a) => {
          const titleStr = a.title ? ` — ${a.title}` : "";
          return `  ${statusEmoji(a.status)} @${a.name}${titleStr}`;
        }).join("\n");
        sections.push(`📁 *${alias}* (${dirName})\n${agentLines}`);
      }

      const working = thronglets.filter((a) => a.status === "working").length;
      const waiting = thronglets.filter((a) => a.status === "waiting").length;
      const sleeping = thronglets.filter((a) => a.status === "sleeping").length;
      const dead = thronglets.filter((a) => a.status === "dead" || a.status === "stopped").length;
      const errored = thronglets.filter((a) => a.status === "error").length;
      const countParts = [`${working} working`, `${waiting} waiting`];
      if (sleeping) countParts.push(`${sleeping} sleeping`);
      if (dead) countParts.push(`${dead} dead`);
      if (errored) countParts.push(`${errored} error`);

      const dispatcher = fleet.getAgent("_dispatcher");
      const dispLine = dispatcher
        ? `\n🔮 *Dispatcher* (Orix): ${dispatcher.status} · ${timeSince(dispatcher.lastActivity)}`
        : "\n⚠️ Dispatcher: offline";

      const header = `Fleet: ${thronglets.length} throngs (${countParts.join(", ")})`;
      await transport.sendReply(chatId, `${header}\n\n${sections.join("\n\n")}${dispLine}`);
      return;
    }

    case "/status": {
      const name = args[0];
      if (name) {
        const agent = fleet.getAgent(name);
        if (!agent) { await transport.sendReply(chatId, `Agent "${name}" not found.`); return; }
        const lines = [
          `*${agent.name}*${agent.title ? ` — ${agent.title}` : ""}`,
          `Runtime: ${agent.runtime}`, `Model: ${agent.model}`,
          `Workspace: ${agent.workspace} (${agent.workspacePath})`,
          `Status: ${agent.status}`, `Last active: ${timeSince(agent.lastActivity)}`,
          `Session: ${agent.currentSessionId}${agent.sessionName ? ` 「${agent.sessionName}」` : ""}`,
          `Messages: ${agent.messageCount}`, `Spawned: ${agent.spawnedAt}`,
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
        `🔮 *Dispatcher* (Orix)`, `Status: ${dispatcherAgent.status}`,
        `Last active: ${timeSince(dispatcherAgent.lastActivity)}`,
        `Session: ${dispatcherAgent.currentSessionId}`,
        `Messages: ${dispatcherAgent.messageCount}`, "", `Use /dispatcher restart to force-restart.`,
      ];
      await transport.sendReply(chatId, lines.join("\n"));
      return;
    }

    case "/title": {
      const tName = args[0];
      const tTitle = args.slice(1).join(" ");
      if (!tName) { await transport.sendReply(chatId, "Usage: /title <name> <title>"); return; }
      if (!fleet.hasAgent(tName)) { await transport.sendReply(chatId, `Agent "${tName}" not found.`); return; }
      const titleResult = fleet.setTitle(tName, tTitle);
      await transport.sendReply(chatId, titleResult);
      return;
    }

    case "/poke": {
      if (!fleet.hasAgent(DISPATCHER_AGENT_NAME)) {
        await transport.sendReply(chatId, "⚠️ Dispatcher is offline. Use /dispatcher restart first.");
        return;
      }
      const goal = fleet.getGoal();
      const pokeMsg = goal ? POKE_MESSAGE_WITH_GOAL : POKE_MESSAGE_NO_GOAL;
      await transport.sendReply(chatId, "👉 Poking dispatcher...");
      await sendToAgent(chatId, DISPATCHER_AGENT_NAME, pokeMsg, transport, fleet, "dispatcher");
      return;
    }

    case "/goal": {
      const newGoal = args.join(" ").trim();
      if (newGoal) {
        fleet.setGoal(newGoal);
        await transport.sendReply(chatId, `Goal set: ${newGoal}`);
      } else {
        const current = fleet.getGoal();
        await transport.sendReply(chatId, current ? `Current goal:\n${current}` : "No goal set. Use /goal <text> to set one.");
      }
      return;
    }

    case "/workspace": {
      const sub = args[0];
      if (sub === "add") {
        const wAlias = args[1]; const wPath = args[2];
        if (!wAlias || !wPath) {
          await transport.sendReply(chatId, "Usage: /workspace add <alias> <path>");
          return;
        }
        const addResult = fleet.addWorkspace(wAlias, wPath);
        await transport.sendReply(chatId, addResult);
        return;
      }
      const wsList = workspaces.map((w) => `  • ${w.alias} — ${w.path}`).join("\n");
      await transport.sendReply(chatId, `Workspaces:\n${wsList || "  (none)"}`);
      return;
    }

    case "/help":
      await transport.sendReply(chatId, [
        "💬 Just type — dispatcher handles routing",
        "  @name msg — send to a specific throng",
        "  @all msg — broadcast to all",
        "", "📋 Commands:",
        "  /hatch [runtime] [workspace] — hatch a throng",
        "  /kill <name> — release",
        "  /fleet — list all + status",
        "  /clear <name> — fresh session",
        "  /title <name> <title> — set title",
        "  /change <name> <field> <value> — reconfigure",
        "  /poke — nudge dispatcher to assign work",
        "  /goal [text] — view or set fleet goal",
        "  /status [name] — detail",
        "  /dispatcher [restart] — dispatcher info",
        "  /workspace [add alias path] — manage workspaces",
      ].join("\n"));
      return;

    default:
      await transport.sendReply(chatId, "Unknown command. Try /help");
  }
}

async function handleMessage(
  chatId: string,
  text: string,
  deps: CommandRouterDeps,
  dispatcherEnabled: boolean,
  cwdAlias: WorkspaceEntry | undefined,
): Promise<void> {
  const { fleet, bus, transport, config, workspaces } = deps;

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

  // No @mention: route to single agent, dispatcher, or prompt user
  const agentList = fleet.listAgents().filter((n) => n !== DISPATCHER_AGENT_NAME);

  if (agentList.length === 1 && !dispatcherEnabled) {
    await sendToAgent(chatId, agentList[0], text, transport, fleet);
  } else if (agentList.length === 0 && !fleet.hasAgent(DISPATCHER_AGENT_NAME)) {
    await transport.sendReply(chatId, "No throngs running.\n\nHatch one: /hatch [runtime] [workspace]");
  } else if (dispatcherEnabled) {
    // Auto-recover dispatcher if needed
    const dispatcherAgent = fleet.getAgent(DISPATCHER_AGENT_NAME);
    if (!dispatcherAgent || dispatcherAgent.status === "dead" || dispatcherAgent.status === "error") {
      await transport.sendReply(chatId, "🔄 Dispatcher is down — restarting...");
      if (dispatcherAgent) await fleet.kill(DISPATCHER_AGENT_NAME);
      const restarted = await startDispatcher(fleet, bus, config, workspaces);
      if (!restarted) {
        await transport.sendReply(chatId, "❌ Dispatcher failed to restart. Use @name to talk to a throng directly.");
        return;
      }
      await transport.sendReply(chatId, "✅ Dispatcher recovered. Routing your message now...");
    }
    await sendToAgent(chatId, DISPATCHER_AGENT_NAME, text, transport, fleet, "dispatcher");
  } else {
    await transport.sendReply(chatId, `Multiple agents running. Use @name to address one:\n${agentList.map((n) => `  @${n}`).join("\n")}\n  @all (broadcast)`);
  }
}

async function sendToAgent(
  chatId: string,
  target: string,
  text: string,
  transport: Transport,
  fleet: FleetManager,
  label?: string,
): Promise<void> {
  await transport.sendTyping(chatId);
  const typingInterval = setInterval(() => { transport.sendTyping(chatId).catch(() => {}); }, 4000);
  const startTime = Date.now();
  const displayName = label || target;
  try {
    const reply = await fleet.send(target, text);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await transport.sendReply(chatId, `[${displayName} · ${elapsed}s]\n${reply}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await transport.sendReply(chatId, `[${displayName} · ${elapsed}s · error]\n${errMsg.slice(0, 500)}`);
  } finally {
    clearInterval(typingInterval);
  }
}
