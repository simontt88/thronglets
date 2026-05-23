import type TelegramBot from "node-telegram-bot-api";
import type { FleetManager } from "../fleet/index.js";
import type { WorkspaceEntry } from "../fleet/index.js";
import type { BridgeConfig, RuntimeType } from "../config.js";

interface PendingFlow {
  action: "new" | "change";
  step: number;
  data: Record<string, string>;
  messageId: number;
  expiresAt: number;
}

const FLOW_TIMEOUT_MS = 60_000;
const pendingFlows = new Map<string, PendingFlow>();

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, flow] of pendingFlows) {
    if (now > flow.expiresAt) pendingFlows.delete(key);
  }
}

export function setupInlineButtons(
  bot: TelegramBot,
  fleet: FleetManager,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): void {
  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;
    const chatId = String(query.message.chat.id);
    const msgId = query.message.message_id;

    const parts = query.data.split(":");
    const [action, step, ...params] = parts;

    try {
      switch (action) {
        case "new":
          await handleNewFlow(bot, fleet, config, workspaces, chatId, msgId, step, params);
          break;
        case "change":
          await handleChangeFlow(bot, fleet, config, workspaces, chatId, msgId, step, params);
          break;
        case "kill":
          await handleKillFlow(bot, fleet, chatId, msgId, step, params);
          break;
        case "clear":
          await handleClearFlow(bot, fleet, chatId, msgId, step, params);
          break;
        case "cancel":
          pendingFlows.delete(chatId);
          await bot.editMessageText("Cancelled.", { chat_id: Number(chatId), message_id: msgId });
          break;
      }
    } catch (err) {
      console.error(`[buttons] callback error:`, err);
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});
  });

  // No text input needed — names are auto-generated
}

async function handleNewFlow(
  bot: TelegramBot,
  fleet: FleetManager,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
  chatId: string,
  msgId: number,
  step: string,
  params: string[],
): Promise<void> {
  switch (step) {
    case "start": {
      const autoName = fleet.autoName();
      const runtimeButtons: Array<Array<{text: string; callback_data: string}>> = config.agents.map((a) => [{
        text: a.runtime,
        callback_data: `new:workspace:${autoName}:${a.runtime}`,
      }]);
      runtimeButtons.push([{ text: "Cancel", callback_data: "cancel:x" }]);

      await bot.editMessageText(`🐣 Hatching "${autoName}" — pick runtime:`, {
        chat_id: Number(chatId),
        message_id: msgId,
        reply_markup: { inline_keyboard: runtimeButtons },
      });
      break;
    }

    case "workspace": {
      const [name, runtime] = params;
      if (workspaces.length === 1) {
        pendingFlows.delete(chatId);
        const result = await fleet.spawn(name, runtime as RuntimeType, workspaces[0].alias);
        await bot.editMessageText(`✅ ${result}`, {
          chat_id: Number(chatId),
          message_id: msgId,
        });
        break;
      }
      const wsButtons = workspaces.map((w) => [{
        text: `${w.alias} · ${w.path.split("/").pop()}`,
        callback_data: `new:exec:${name}:${runtime}:${w.alias}`,
      }]);
      wsButtons.push([{ text: "Cancel", callback_data: "cancel:x" }]);

      await bot.editMessageText(`📁 Pick workspace for "${name}" (${runtime}):`, {
        chat_id: Number(chatId),
        message_id: msgId,
        reply_markup: { inline_keyboard: wsButtons },
      });
      break;
    }

    case "exec": {
      const [name, runtime, workspace] = params;
      pendingFlows.delete(chatId);
      const result = await fleet.spawn(name, runtime as RuntimeType, workspace);
      await bot.editMessageText(`✅ ${result}`, {
        chat_id: Number(chatId),
        message_id: msgId,
      });
      break;
    }
  }
}

async function handleChangeFlow(
  bot: TelegramBot,
  fleet: FleetManager,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
  chatId: string,
  msgId: number,
  step: string,
  params: string[],
): Promise<void> {
  switch (step) {
    case "start": {
      const agents = fleet.listAgents();
      if (agents.length === 0) {
        await bot.editMessageText("No agents running. Use /new first.", {
          chat_id: Number(chatId), message_id: msgId,
        });
        return;
      }
      const buttons = agents.map((name) => [{
        text: name,
        callback_data: `change:field:${name}`,
      }]);
      buttons.push([{ text: "Cancel", callback_data: "cancel:x" }]);
      await bot.editMessageText("Which agent to change?", {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "field": {
      const [name] = params;
      const buttons = [
        [{ text: "Model", callback_data: `change:model_pick:${name}` }],
        [{ text: "Workspace", callback_data: `change:ws_pick:${name}` }],
        [{ text: "Runtime", callback_data: `change:rt_pick:${name}` }],
        [{ text: "Cancel", callback_data: "cancel:x" }],
      ];
      await bot.editMessageText(`What to change for "${name}"?`, {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "model_pick": {
      const [name] = params;
      const models = ["claude-opus-4-6", "claude-sonnet-4-6", "o3", "gpt-4.1", "codex-mini"];
      const buttons = models.map((m) => [{
        text: m,
        callback_data: `change:exec:${name}:model:${m}`,
      }]);
      buttons.push([{ text: "Cancel", callback_data: "cancel:x" }]);
      await bot.editMessageText(`Pick new model for "${name}":`, {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "ws_pick": {
      const [name] = params;
      const buttons = workspaces.map((w) => [{
        text: `${w.alias} · ${w.path.split("/").pop()}`,
        callback_data: `change:exec:${name}:workspace:${w.alias}`,
      }]);
      buttons.push([{ text: "Cancel", callback_data: "cancel:x" }]);
      await bot.editMessageText(`Pick new workspace for "${name}":`, {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "rt_pick": {
      const [name] = params;
      const runtimes = ["cursor", "claude-code", "codex"];
      const buttons = runtimes.map((r) => [{
        text: r,
        callback_data: `change:exec:${name}:runtime:${r}`,
      }]);
      buttons.push([{ text: "Cancel", callback_data: "cancel:x" }]);
      await bot.editMessageText(`Pick new runtime for "${name}":`, {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "exec": {
      const [name, field, value] = params;
      const result = await fleet.change(name, field, value, config, workspaces);
      await bot.editMessageText(`✅ ${result}`, {
        chat_id: Number(chatId), message_id: msgId,
      });
      break;
    }
  }
}

async function handleKillFlow(
  bot: TelegramBot,
  fleet: FleetManager,
  chatId: string,
  msgId: number,
  step: string,
  params: string[],
): Promise<void> {
  switch (step) {
    case "start": {
      const agents = fleet.listAgents();
      if (agents.length === 0) {
        await bot.editMessageText("No agents to kill.", {
          chat_id: Number(chatId), message_id: msgId,
        });
        return;
      }
      const buttons = agents.map((name) => [{
        text: name,
        callback_data: `kill:confirm:${name}`,
      }]);
      buttons.push([{ text: "Cancel", callback_data: "cancel:x" }]);
      await bot.editMessageText("Which agent to kill?", {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "confirm": {
      const [name] = params;
      const buttons = [
        [{ text: `⚠️ Confirm Kill "${name}"`, callback_data: `kill:exec:${name}` }],
        [{ text: "Cancel", callback_data: "cancel:x" }],
      ];
      await bot.editMessageText(`Kill "${name}"? Session will be archived.`, {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "exec": {
      const [name] = params;
      const result = await fleet.kill(name);
      await bot.editMessageText(`✅ ${result}`, {
        chat_id: Number(chatId), message_id: msgId,
      });
      break;
    }
  }
}

async function handleClearFlow(
  bot: TelegramBot,
  fleet: FleetManager,
  chatId: string,
  msgId: number,
  step: string,
  params: string[],
): Promise<void> {
  switch (step) {
    case "start": {
      const agents = fleet.listAgents();
      if (agents.length === 0) {
        await bot.editMessageText("No agents running.", {
          chat_id: Number(chatId), message_id: msgId,
        });
        return;
      }
      const buttons = agents.map((name) => [{
        text: name,
        callback_data: `clear:exec:${name}`,
      }]);
      buttons.push([{ text: "Cancel", callback_data: "cancel:x" }]);
      await bot.editMessageText("Reset session for which agent?", {
        chat_id: Number(chatId), message_id: msgId,
        reply_markup: { inline_keyboard: buttons },
      });
      break;
    }

    case "exec": {
      const [name] = params;
      const result = await fleet.clear(name);
      await bot.editMessageText(`✅ ${result}`, {
        chat_id: Number(chatId), message_id: msgId,
      });
      break;
    }
  }
}

export function sendNewPrompt(bot: TelegramBot, chatId: string): void {
  bot.sendMessage(Number(chatId), "🐣 Hatch a new thronglet:", {
    reply_markup: {
      inline_keyboard: [[{ text: "Hatch →", callback_data: "new:start" }]],
    },
  }).catch(() => {});
}

export function sendChangePrompt(bot: TelegramBot, chatId: string): void {
  bot.sendMessage(Number(chatId), "🔄 Change agent config:", {
    reply_markup: {
      inline_keyboard: [[{ text: "Start →", callback_data: "change:start" }]],
    },
  }).catch(() => {});
}

export function sendKillPrompt(bot: TelegramBot, chatId: string): void {
  bot.sendMessage(Number(chatId), "💀 Kill an agent:", {
    reply_markup: {
      inline_keyboard: [[{ text: "Start →", callback_data: "kill:start" }]],
    },
  }).catch(() => {});
}

export function sendClearPrompt(bot: TelegramBot, chatId: string): void {
  bot.sendMessage(Number(chatId), "🧹 Clear agent session:", {
    reply_markup: {
      inline_keyboard: [[{ text: "Start →", callback_data: "clear:start" }]],
    },
  }).catch(() => {});
}
