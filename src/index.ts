import { loadConfig } from "./config.js";
import { TelegramTransport } from "./transports/telegram.js";
import { CursorRuntime } from "./runtimes/cursor.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import type { Transport } from "./transports/interface.js";
import type { Runtime } from "./runtimes/interface.js";

const config = loadConfig();

// --- Resolve transport ---
function createTransport(): Transport {
  switch (config.transport) {
    case "telegram":
      if (!config.telegram?.token) {
        console.error("[fatal] telegram.token is required");
        process.exit(1);
      }
      return new TelegramTransport({
        token: config.telegram.token,
        allowedChats: config.telegram.allowedChats,
      });
    default:
      console.error(`[fatal] unsupported transport: ${config.transport}`);
      process.exit(1);
  }
}

// --- Resolve runtime ---
function createRuntime(): Runtime {
  switch (config.runtime) {
    case "cursor":
      if (!config.cursor?.apiKey) {
        console.error("[fatal] cursor.apiKey is required");
        process.exit(1);
      }
      return new CursorRuntime({
        apiKey: config.cursor.apiKey,
        model: config.cursor.model || "claude-opus-4-6",
      });
    default:
      console.error(`[fatal] unsupported runtime: ${config.runtime}`);
      process.exit(1);
  }
}

// --- Main ---
async function main() {
  const transport = createTransport();
  const runtime = createRuntime();

  const store = new SessionStore(
    config.session!.logDir,
    config.session?.recallApi
      ? {
          apiUrl: config.session.recallApi,
          apiKey: config.session.recallKey || "",
          workspacePath: config.workspace,
        }
      : undefined
  );

  const sessions = new SessionManager(runtime, store, {
    workspace: config.workspace,
    model: config.cursor?.model || "claude-opus-4-6",
  });

  let processing = new Set<string>();

  transport.onMessage(async (msg) => {
    const { chatId, text } = msg;

    // Built-in commands
    if (msg.isCommand) {
      if (text === "/clear") {
        const newId = await sessions.clear(chatId);
        await transport.sendReply(chatId, `Session cleared. New session will start on next message.`);
        return;
      }

      if (text === "/status") {
        const status = sessions.getStatus(chatId);
        const lines = [
          `Transport: ${transport.name}`,
          `Runtime: ${runtime.name}`,
          `Workspace: ${config.workspace}`,
          `Session: ${status.active ? status.sessionId : "(none)"}`,
          `Messages: ${status.messageCount || 0}`,
          `Model: ${config.cursor?.model || "default"}`,
        ];
        await transport.sendReply(chatId, lines.join("\n"));
        return;
      }

      if (text === "/help") {
        await transport.sendReply(chatId, "Commands: /clear /status /help");
        return;
      }

      await transport.sendReply(chatId, "Unknown command. Try /help");
      return;
    }

    // Prevent concurrent processing per chat
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
      const startTime = Date.now();
      const reply = await sessions.send(chatId, text);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[done] chat=${chatId} ${elapsed}s ${reply.length}chars`);
      await transport.sendReply(chatId, reply);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[error] chat=${chatId}: ${errMsg}`);
      store.log({ sessionId: "error", chatId, role: "error", content: errMsg });
      await transport.sendReply(chatId, `Error: ${errMsg}`);
      // Reset session on error
      await sessions.clear(chatId);
    } finally {
      clearInterval(typingInterval);
      processing.delete(chatId);
    }
  });

  await transport.start();

  console.log(`\nAgent Bridge started`);
  console.log(`  Transport: ${transport.name}`);
  console.log(`  Runtime:   ${runtime.name}`);
  console.log(`  Workspace: ${config.workspace}`);
  console.log(`  Model:     ${config.cursor?.model || "default"}`);
  console.log(`  Logs:      ${config.session!.logDir}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});
