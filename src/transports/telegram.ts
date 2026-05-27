import TelegramBot from "node-telegram-bot-api";
import { existsSync, readFileSync, writeFileSync, unlinkSync, createReadStream } from "fs";
import { join } from "path";
import type { Transport, IncomingMessage, TransportOptions, MediaAttachment, OutgoingMedia } from "./interface.js";
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

      if (this.allowedChats.size > 0 && !this.allowedChats.has(chatId)) {
        console.log(`[telegram] ignored message from unauthorized chat: ${chatId}`);
        return;
      }

      const attachments: MediaAttachment[] = [];
      let text = msg.text?.trim() || msg.caption?.trim() || "";

      if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo[msg.photo.length - 1];
        const fileUrl = await this.resolveFileUrl(largest.file_id);
        attachments.push({
          type: "photo",
          fileId: largest.file_id,
          fileSize: largest.file_size,
          url: fileUrl || undefined,
        });
      }

      if (msg.document) {
        const fileUrl = await this.resolveFileUrl(msg.document.file_id);
        attachments.push({
          type: "document",
          fileId: msg.document.file_id,
          fileName: msg.document.file_name || undefined,
          mimeType: msg.document.mime_type || undefined,
          fileSize: msg.document.file_size,
          url: fileUrl || undefined,
        });
      }

      if (msg.video) {
        const fileUrl = await this.resolveFileUrl(msg.video.file_id);
        attachments.push({
          type: "video",
          fileId: msg.video.file_id,
          fileSize: msg.video.file_size,
          mimeType: msg.video.mime_type || undefined,
          url: fileUrl || undefined,
        });
      }

      if (!text && attachments.length === 0) return;

      // Build text context from attachments so agents always get a description
      if (attachments.length > 0 && !text) {
        text = attachments.map((a) => {
          if (a.type === "photo") return "[User sent a photo]";
          if (a.type === "document") return `[User sent file: ${a.fileName || "document"}]`;
          if (a.type === "video") return "[User sent a video]";
          return `[User sent ${a.type}]`;
        }).join("\n");
      }

      const incoming: IncomingMessage = {
        chatId,
        userId: String(msg.from?.id || msg.chat.id),
        text,
        username: msg.from?.username || msg.from?.first_name,
        isCommand: text.startsWith("/"),
        raw: msg,
        attachments: attachments.length > 0 ? attachments : undefined,
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

  private async resolveFileUrl(fileId: string): Promise<string | null> {
    if (!this.bot) return null;
    try {
      return await this.bot.getFileLink(fileId);
    } catch (err) {
      console.warn(`[telegram] failed to resolve file link for ${fileId}: ${(err as Error).message}`);
      return null;
    }
  }

  async sendMedia(chatId: string, media: OutgoingMedia): Promise<void> {
    if (!this.bot) return;
    const numChatId = Number(chatId);
    const opts: Record<string, unknown> = {};
    if (media.caption) opts.caption = media.caption;

    try {
      if (media.type === "photo") {
        if (media.source.startsWith("http://") || media.source.startsWith("https://")) {
          await this.bot.sendPhoto(numChatId, media.source, opts);
        } else if (existsSync(media.source)) {
          await this.bot.sendPhoto(numChatId, createReadStream(media.source) as any, opts);
        } else {
          console.warn(`[telegram] sendMedia: photo source not found: ${media.source}`);
        }
      } else if (media.type === "document") {
        if (media.source.startsWith("http://") || media.source.startsWith("https://")) {
          await this.bot.sendDocument(numChatId, media.source, opts);
        } else if (existsSync(media.source)) {
          await this.bot.sendDocument(numChatId, createReadStream(media.source) as any, opts, {
            filename: media.fileName || media.source.split("/").pop() || "file",
          });
        } else {
          console.warn(`[telegram] sendMedia: document source not found: ${media.source}`);
        }
      }
    } catch (err) {
      console.error(`[telegram] sendMedia failed: ${(err as Error).message}`);
      if (media.caption) {
        await this.sendReply(chatId, `📎 ${media.caption}\n(media send failed: ${media.source})`);
      }
    }
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

