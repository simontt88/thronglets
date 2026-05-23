import TelegramBot from "node-telegram-bot-api";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Transport, IncomingMessage, TransportOptions } from "./interface.js";
import { renderAvatarPNG } from "../fleet/render-avatar.js";

const THRONGLETS_HOME = process.env.THRONGLETS_HOME || join(homedir(), ".thronglets");
const PID_FILE = join(THRONGLETS_HOME, "bridge.pid");
const AVATAR_FLAG = join(THRONGLETS_HOME, "bot-avatar-set");

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
    // Kill any previous instance using the same bot token
    this.killPreviousInstance();
    this.writePidFile();

    // Clear any lingering webhook before polling
    const tempBot = new TelegramBot(this.config.token);
    await tempBot.deleteWebHook().catch(() => {});
    await tempBot.close().catch(() => {});

    // Wait for Telegram to release the polling connection
    await new Promise((r) => setTimeout(r, 2000));

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
      { command: "new", description: "Hatch a thronglet (auto-named)" },
      { command: "kill", description: "Release: /kill <name>" },
      { command: "change", description: "Reconfigure: /change <name> model|workspace|runtime <val>" },
      { command: "fleet", description: "List all thronglets + status" },
      { command: "clear", description: "Reset session: /clear <name>" },
      { command: "status", description: "Detail: /status <name>" },
      { command: "help", description: "Show all commands" },
    ]).catch(() => {});

    // Set bot profile photo (once, on first startup)
    this.setInitialAvatar().catch((err) => {
      console.warn(`[telegram] avatar set failed: ${(err as Error).message?.slice(0, 80)}`);
    });

    console.log(`[telegram] transport started`);
  }

  private async setInitialAvatar(): Promise<void> {
    if (existsSync(AVATAR_FLAG)) return;
    if (!this.bot) return;

    const seed = `thronglet-bot-${Date.now()}`;
    const png = renderAvatarPNG(seed);
    mkdirSync(THRONGLETS_HOME, { recursive: true });
    writeFileSync(join(THRONGLETS_HOME, "bot-avatar.png"), png);

    try {
      const url = `https://api.telegram.org/bot${this.config.token}/setMyProfilePhoto`;
      const boundary = "----ThrongletsAvatar" + Date.now();
      const photoJson = JSON.stringify({ type: "static", photo: "attach://photo_file" });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"\r\n\r\n${photoJson}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo_file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      });

      if (res.ok) {
        writeFileSync(AVATAR_FLAG, seed);
        console.log("[telegram] bot avatar set successfully");
      } else {
        const text = await res.text();
        console.warn(`[telegram] avatar API returned ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[telegram] avatar upload error: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  async stop(): Promise<void> {
    this.bot?.stopPolling();
    try { unlinkSync(PID_FILE); } catch {}
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

    const chunks = splitMessage(text, MAX_LEN - 100);
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
