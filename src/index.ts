import { loadConfig, getAgentByName, type BridgeConfig, type AgentDef } from "./config.js";
import { TelegramTransport } from "./transports/telegram.js";
import { CursorRuntime } from "./runtimes/cursor.js";
import { ClaudeCodeRuntime } from "./runtimes/claude-code.js";
import { CodexRuntime } from "./runtimes/codex.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { syncRules } from "./rules-sync.js";
import type { Transport } from "./transports/interface.js";
import type { Runtime } from "./runtimes/interface.js";

const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 3000;
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

interface ChatState {
  activeAgent: string;
  sessions: SessionManager;
  runtime: Runtime;
}

async function main() {
  const config = loadConfig();

  if (!config.agents.length) {
    console.error("[fatal] no agents configured. Add an 'agents:' section to your bridge.yaml");
    process.exit(1);
  }

  const transport = createTransport(config);

  const store = new SessionStore({
    logDir: config.session!.logDir,
    storeDir: config.session!.storeDir!,
    recallMode: config.session!.recall || "local",
    cloud: config.session?.recallApi
      ? {
          apiUrl: config.session.recallApi,
          apiKey: config.session.recallKey || "",
          workspacePath: config.workspace,
        }
      : undefined,
  });

  // Per-chat state: each chat can independently switch agents
  const chatStates = new Map<string, ChatState>();

  async function ensureRulesSync(agentDef: AgentDef) {
    if (agentDef.runtime === "claude-code") {
      try {
        await syncRules(config.workspace, "claude-code");
      } catch (err) {
        console.warn(`[rules-sync] failed for claude-code: ${(err as Error).message}`);
      }
    } else if (agentDef.runtime === "codex") {
      try {
        await syncRules(config.workspace, "codex");
      } catch (err) {
        console.warn(`[rules-sync] failed for codex: ${(err as Error).message}`);
      }
    }
  }

  async function getOrCreateChatState(chatId: string): Promise<ChatState> {
    let state = chatStates.get(chatId);
    if (state) return state;

    const agentName = config.active || config.agents[0].name;
    const agentDef = getAgentByName(config, agentName) || config.agents[0];
    await ensureRulesSync(agentDef);
    const runtime = createRuntime(agentDef);

    state = {
      activeAgent: agentDef.name,
      runtime,
      sessions: new SessionManager(runtime, store, {
        workspace: config.workspace,
        model: agentDef.model,
        sessionTtlMs: SESSION_TTL_MS,
      }),
    };
    chatStates.set(chatId, state);
    return state;
  }

  async function switchAgent(chatId: string, agentName: string): Promise<AgentDef | null> {
    const agentDef = getAgentByName(config, agentName);
    if (!agentDef) return null;

    const existing = chatStates.get(chatId);
    if (existing) {
      existing.sessions.clear(chatId);
    }

    await ensureRulesSync(agentDef);
    const runtime = createRuntime(agentDef);
    const state: ChatState = {
      activeAgent: agentDef.name,
      runtime,
      sessions: new SessionManager(runtime, store, {
        workspace: config.workspace,
        model: agentDef.model,
        sessionTtlMs: SESSION_TTL_MS,
      }),
    };
    chatStates.set(chatId, state);
    return agentDef;
  }

  const processing = new Set<string>();

  transport.onMessage(async (msg) => {
    const { chatId, text } = msg;

    if (msg.isCommand) {
      const [cmd, ...args] = text.split(" ");
      const arg = args.join(" ").trim();

      switch (cmd) {
        case "/agent": {
          if (!arg) {
            const state = await getOrCreateChatState(chatId);
            const lines = config.agents.map((a) => {
              const active = a.name === state.activeAgent ? " ← active" : "";
              return `• ${a.name} (${a.runtime} / ${a.model})${active}`;
            });
            await transport.sendReply(chatId, `Available agents:\n${lines.join("\n")}\n\nUse /agent <name> to switch`);
          } else {
            const switched = await switchAgent(chatId, arg);
            if (switched) {
              await transport.sendReply(chatId, `Switched to: ${switched.name}\nRuntime: ${switched.runtime}\nModel: ${switched.model}`);
            } else {
              const names = config.agents.map((a) => a.name).join(", ");
              await transport.sendReply(chatId, `Unknown agent "${arg}". Available: ${names}`);
            }
          }
          return;
        }

        case "/clear": {
          const state = await getOrCreateChatState(chatId);
          await state.sessions.clear(chatId);
          await transport.sendReply(chatId, "Session cleared.");
          return;
        }

        case "/status": {
          const state = await getOrCreateChatState(chatId);
          const status = state.sessions.getStatus(chatId);
          const agentDef = getAgentByName(config, state.activeAgent);
          const lines = [
            `Agent: ${state.activeAgent}`,
            `Runtime: ${agentDef?.runtime || "?"}`,
            `Model: ${agentDef?.model || "?"}`,
            `Workspace: ${config.workspace}`,
            `Session: ${status.active ? status.sessionId : "(none)"}`,
            `Messages: ${status.messageCount || 0}`,
          ];
          await transport.sendReply(chatId, lines.join("\n"));
          return;
        }

        case "/help":
          await transport.sendReply(chatId, "Commands:\n/agent [name] — list or switch agents\n/clear — reset session\n/status — current state\n/help — this message");
          return;

        default:
          await transport.sendReply(chatId, "Unknown command. Try /help");
          return;
      }
    }

    if (processing.has(chatId)) {
      await transport.sendReply(chatId, "Still processing previous message...");
      return;
    }

    processing.add(chatId);
    await transport.sendTyping(chatId);

    const typingInterval = setInterval(() => {
      transport.sendTyping(chatId).catch(() => {});
    }, 4000);

    try {
      const state = await getOrCreateChatState(chatId);
      const startTime = Date.now();
      let reply: string | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          reply = await state.sessions.send(chatId, text);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < MAX_RETRIES && isRetryable(msg)) {
            console.log(`[retry] attempt ${attempt + 1} for chat=${chatId}: ${msg.slice(0, 100)}`);
            await sleep(RETRY_DELAY_MS);
            await state.sessions.clear(chatId);
          } else {
            throw err;
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[done] chat=${chatId} agent=${state.activeAgent} ${elapsed}s ${(reply || "").length}chars`);
      await transport.sendReply(chatId, reply || "(empty response)");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[error] chat=${chatId}: ${errMsg}`);
      store.log({ sessionId: "error", chatId, role: "error", content: errMsg });
      await transport.sendReply(chatId, `Error: ${errMsg.slice(0, 500)}`);
      const state = chatStates.get(chatId);
      if (state) await state.sessions.clear(chatId);
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  });

  await transport.start();

  const activeAgent = getAgentByName(config, config.active) || config.agents[0];
  console.log(`\nAgent Bridge started`);
  console.log(`  Transport: ${transport.name}`);
  console.log(`  Workspace: ${config.workspace}`);
  console.log(`  Agents:    ${config.agents.map((a) => a.name).join(", ")}`);
  console.log(`  Active:    ${activeAgent.name} (${activeAgent.runtime} / ${activeAgent.model})`);
  console.log(`  Logs:      ${config.session!.logDir}`);

  // Heartbeat
  setInterval(() => {
    console.log(`[heartbeat] ${new Date().toISOString()} agents=${chatStates.size} processing=${processing.size}`);
  }, 5 * 60 * 1000);
}

function isRetryable(errMsg: string): boolean {
  const retryable = ["ECONNRESET", "ETIMEDOUT", "socket hang up", "network", "502", "503"];
  const lower = errMsg.toLowerCase();
  return retryable.some((r) => lower.includes(r.toLowerCase()));
}

async function run() {
  while (true) {
    try {
      await main();
      break; // clean exit
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
