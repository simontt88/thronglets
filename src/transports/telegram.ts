import TelegramBot from "node-telegram-bot-api";
import type { Transport, IncomingMessage, TransportOptions } from "./interface.js";

export interface TelegramConfig {
  token: string;
  allowedChats?: string[];
}

export class TelegramTransport implements Transport {
  readonly name = "telegram";
  private bot: TelegramBot;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private allowedChats: Set<string>;

  constructor(private config: TelegramConfig) {
    this.bot = new TelegramBot(config.token, { polling: true });
    this.allowedChats = new Set(config.allowedChats || []);
  }

  async start(): Promise<void> {
    this.bot.on("polling_error", (err) => {
      console.error(`[telegram] polling error: ${err.message}`);
    });

    this.bot.on("message", async (msg) => {
      if (!this.handler) return;

      const chatId = String(msg.chat.id);
      const text = msg.text?.trim();
      if (!text) return;

      if (this.allowedChats.size > 0 && !this.allowedChats.has(chatId)) {
        console.log(`[telegram] ignored message from unauthorized chat: ${chatId}`);
        return;
      }

      const incoming: IncomingMessage = {
        chatId,
        userId: String(msg.from?.id || msg.chat.id),
        text,
        username: msg.from?.username || msg.from?.first_name,
        isCommand: text.startsWith("/"),
        raw: msg,
      };

      await this.handler(incoming);
    });

    console.log(`[telegram] transport started`);
  }

  async stop(): Promise<void> {
    this.bot.stopPolling();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendReply(chatId: string, text: string): Promise<void> {
    const MAX_LEN = 4096;

    if (text.length <= MAX_LEN) {
      await this.bot.sendMessage(Number(chatId), text, { parse_mode: "Markdown" }).catch(() => {
        this.bot.sendMessage(Number(chatId), text);
      });
      return;
    }

    const chunks = splitMessage(text, MAX_LEN - 100);
    for (const chunk of chunks) {
      await this.bot.sendMessage(Number(chatId), chunk, { parse_mode: "Markdown" }).catch(() => {
        this.bot.sendMessage(Number(chatId), chunk);
      });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.sendChatAction(Number(chatId), "typing").catch(() => {});
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}
