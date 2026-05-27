import type { Transport, IncomingMessage, OutgoingMedia } from "./interface.js";
import type { DiscordConfig } from "../config.js";
import { splitText } from "../utils/chunk-text.js";

export class DiscordTransport implements Transport {
  readonly name = "discord";
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private client: unknown = null;
  private allowedUsers: Set<string>;

  constructor(private config: DiscordConfig) {
    this.allowedUsers = new Set(config.allowedUsers || []);
  }

  async start(): Promise<void> {
    let discord: Record<string, unknown>;
    try {
      discord = await import("discord.js") as Record<string, unknown>;
    } catch {
      throw new Error(
        "discord.js not installed. Run: npm install discord.js"
      );
    }

    const { Client, GatewayIntentBits, Partials } = discord as {
      Client: new (opts: Record<string, unknown>) => {
        on: (event: string, handler: (...args: unknown[]) => void) => void;
        login: (token: string) => Promise<void>;
        destroy: () => void;
        channels: { fetch: (id: string) => Promise<{ isTextBased: () => boolean; send: (text: string) => Promise<unknown> } | null> };
      };
      GatewayIntentBits: Record<string, number>;
      Partials: Record<string, number>;
    };

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    const c = this.client as {
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      login: (token: string) => Promise<void>;
    };

    c.on("messageCreate", async (msg: unknown) => {
      if (!this.handler) return;

      const m = msg as {
        author: { bot: boolean; id: string; username: string };
        guild: unknown;
        channel: { id: string };
        content: string;
      };

      if (m.author.bot) return;
      if (m.guild) return; // DM only

      if (this.allowedUsers.size > 0 && !this.allowedUsers.has(m.author.id)) {
        console.log(`[discord] ignored message from unauthorized user: ${m.author.id}`);
        return;
      }

      const text = m.content?.trim();
      if (!text) return;

      await this.handler({
        chatId: m.channel.id,
        userId: m.author.id,
        text,
        username: m.author.username,
        isCommand: text.startsWith("/"),
        raw: msg,
      });
    });

    c.on("error", (err: unknown) => {
      console.error(`[discord] client error:`, err);
    });

    await c.login(this.config.token);
    console.log("[discord] transport started (gateway)");
  }

  async stop(): Promise<void> {
    if (this.client) {
      (this.client as { destroy: () => void }).destroy();
    }
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendMedia(chatId: string, media: OutgoingMedia): Promise<void> {
    const caption = media.caption ? `📎 ${media.caption}` : `📎 ${media.source}`;
    await this.sendReply(chatId, caption);
  }

  async sendReply(chatId: string, text: string): Promise<void> {
    if (!this.client) return;

    const c = this.client as {
      channels: { fetch: (id: string) => Promise<{ isTextBased: () => boolean; send: (text: string) => Promise<unknown> } | null> };
    };

    try {
      const channel = await c.channels.fetch(chatId);
      if (!channel || !channel.isTextBased()) return;

      const chunks = splitText(text, 2000); // Discord limit
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } catch (err) {
      console.error(`[discord] sendReply error:`, err);
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;

    try {
      const c = this.client as {
        channels: { fetch: (id: string) => Promise<{ sendTyping?: () => Promise<void> } | null> };
      };
      const channel = await c.channels.fetch(chatId);
      if (channel && typeof (channel as { sendTyping?: () => Promise<void> }).sendTyping === "function") {
        await (channel as { sendTyping: () => Promise<void> }).sendTyping();
      }
    } catch {
      // typing indicator is best-effort
    }
  }
}
