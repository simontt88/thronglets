import TelegramBot from "node-telegram-bot-api";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { Transport, IncomingMessage, TransportOptions } from "./interface.js";
import { GLOBAL_CONFIG_DIR } from "../config.js";
import { splitText } from "../utils/chunk-text.js";

const THRONGLETS_HOME = GLOBAL_CONFIG_DIR;
const PID_FILE = join(THRONGLETS_HOME, "bridge.pid");
const CLEAN_STOP_FILE = join(THRONGLETS_HOME, "bridge.clean-stop");

export interface TelegramConfig {
  token: string;
  allowedChats?: string[];
}

export class TelegramTransport implements Transport {
  readonly name = "telegram";
  private bot: TelegramBot | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private allowedChats: Set<string>;

  getBot(): TelegramBot | null {
    return this.bot;
  }

  constructor(private config: TelegramConfig) {
    this.allowedChats = new Set(config.allowedChats || []);
  }

  private killPreviousInstance(): void {
    if (!existsSync(PID_FILE)) return;
    try {
      const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        process.kill(oldPid, "SIGKILL");
        console.log(`[telegram] killed previous instance (pid ${oldPid})`);
      }
    } catch {
      // Process already dead or permission error — fine
    }
    try { unlinkSync(PID_FILE); } catch {}
  }

  private writePidFile(): void {
    writeFileSync(PID_FILE, String(process.pid));
  }

  async start(): Promise<void> {
    this.killPreviousInstance();
    this.writePidFile();

    const wasCleanStop = existsSync(CLEAN_STOP_FILE);
    if (wasCleanStop) {
      try { unlinkSync(CLEAN_STOP_FILE); } catch {}
      console.log(`[telegram] previous instance stopped cleanly — fast start`);
    }

    const tempBot = new TelegramBot(this.config.token);
    await tempBot.deleteWebHook().catch(() => {});
    await tempBot.close().catch(() => {});

    // If previous process stopped cleanly, Telegram already released the polling
    // connection — only need a brief settle. Otherwise wait the full 2s.
    const waitMs = wasCleanStop ? 300 : 2000;
    await new Promise((r) => setTimeout(r, waitMs));

    this.bot = new TelegramBot(this.config.token, { polling: { params: { timeout: 30 } } });

    this.bot.on("polling_error", (err) => {
      console.error(`[telegram] polling error: ${err.message}`);
    });

    this.bot!.on("message", async (msg) => {
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

    // Register slash commands for autocomplete menu
    this.bot.setMyCommands([
      { command: "start", description: "Welcome & setup info" },
      { command: "hatch", description: "Hatch a throng (auto-named)" },
      { command: "kill", description: "Release: /kill <name>" },
      { command: "fleet", description: "Fleet status — all throngs" },
      { command: "dispatcher", description: "Dispatcher status / restart" },
      { command: "status", description: "Detail: /status <name>" },
      { command: "title", description: "Set title: /title <name> <title>" },
      { command: "workspace", description: "List or add: /workspace [add alias path]" },
      { command: "change", description: "Reconfigure: /change <name> field <val>" },
      { command: "clear", description: "Reset session: /clear <name>" },
      { command: "help", description: "Show all commands" },
    ]).catch(() => {});

    console.log(`[telegram] transport started`);
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling().catch(() => {});
      this.bot = null;
    }
    try { unlinkSync(PID_FILE); } catch {}
    writeFileSync(CLEAN_STOP_FILE, String(Date.now()));
    console.log(`[telegram] transport stopped (clean-stop marker written)`);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.bot) return;
    const MAX_LEN = 4096;

    if (text.length <= MAX_LEN) {
      await this.bot.sendMessage(Number(chatId), text, { parse_mode: "Markdown" }).catch(() => {
        this.bot!.sendMessage(Number(chatId), text).catch(() => {});
      });
      return;
    }

    const chunks = splitText(text, MAX_LEN - 100);
    for (const chunk of chunks) {
      await this.bot.sendMessage(Number(chatId), chunk, { parse_mode: "Markdown" }).catch(() => {
        this.bot!.sendMessage(Number(chatId), chunk).catch(() => {});
      });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot?.sendChatAction(Number(chatId), "typing").catch(() => {});
  }
}

