import type { Transport, IncomingMessage, OutgoingMedia } from "./interface.js";
import type { LarkConfig } from "../config.js";
import { splitText } from "../utils/chunk-text.js";

export class LarkTransport implements Transport {
  readonly name = "lark";
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private client: unknown = null;
  private wsClient: unknown = null;
  private allowedChats: Set<string>;

  constructor(private config: LarkConfig) {
    this.allowedChats = new Set(config.allowedChats || []);
  }

  async start(): Promise<void> {
    let Lark: Record<string, unknown>;
    try {
      Lark = await import("@larksuiteoapi/node-sdk") as Record<string, unknown>;
    } catch {
      throw new Error(
        "Lark SDK not installed. Run: npm install @larksuiteoapi/node-sdk"
      );
    }

    const ClientClass = Lark.Client as new (opts: Record<string, unknown>) => unknown;
    const WSClientClass = Lark.WSClient as new (opts: Record<string, unknown>) => { start: (opts: Record<string, unknown>) => void };
    const EventDispatcherClass = Lark.EventDispatcher as new (opts: Record<string, unknown>) => { register: (handlers: Record<string, (data: unknown) => Promise<void>>) => unknown };
    const Domain = Lark.Domain as Record<string, string>;

    this.client = new ClientClass({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: "SelfBuild",
      domain: Domain?.Feishu || Domain?.Lark || "https://open.feishu.cn",
    });

    this.wsClient = new WSClientClass({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    const dispatcher = new EventDispatcherClass({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        if (!this.handler) return;

        const evt = data as {
          message: { chat_id: string; message_id: string; content: string; message_type: string };
          sender: { sender_id: { user_id?: string; open_id?: string }; sender_type: string };
        };

        if (evt.sender.sender_type === "bot") return;

        const chatId = evt.message.chat_id;
        if (this.allowedChats.size > 0 && !this.allowedChats.has(chatId)) {
          console.log(`[lark] ignored message from unauthorized chat: ${chatId}`);
          return;
        }

        if (evt.message.message_type !== "text") {
          console.log(`[lark] ignored non-text message type: ${evt.message.message_type}`);
          return;
        }

        let text: string;
        try {
          text = JSON.parse(evt.message.content).text || "";
        } catch {
          text = evt.message.content;
        }
        text = text.trim();
        if (!text) return;

        await this.handler({
          chatId,
          userId: evt.sender.sender_id.user_id || evt.sender.sender_id.open_id || "unknown",
          text,
          isCommand: text.startsWith("/"),
          raw: data,
        });
      },
    });

    (this.wsClient as { start: (opts: Record<string, unknown>) => void }).start({
      eventDispatcher: dispatcher,
    });

    console.log("[lark] transport started (WebSocket long connection)");
  }

  async stop(): Promise<void> {
    // Lark WSClient doesn't expose a clean stop method — process exit handles cleanup
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

    const chunks = splitText(text, 4000);
    for (const chunk of chunks) {
      try {
        const c = this.client as {
          im: { message: { create: (opts: Record<string, unknown>) => Promise<unknown> } };
        };
        await c.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          },
        });
      } catch (err) {
        console.error(`[lark] sendReply error:`, err);
        break;
      }
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Lark API does not have a typing indicator
  }
}

