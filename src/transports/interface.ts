export interface MediaAttachment {
  type: "photo" | "document" | "video" | "voice" | "animation";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  caption?: string;
  url?: string;
  thumbnailUrl?: string;
}

export interface OutgoingMedia {
  type: "photo" | "document";
  source: string;
  caption?: string;
  fileName?: string;
}

export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  username?: string;
  isCommand?: boolean;
  raw?: unknown;
  attachments?: MediaAttachment[];
}

export interface TransportOptions {
  allowedChats?: string[];
}

export interface Transport {
  readonly name: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  sendReply(chatId: string, text: string): Promise<void>;
  sendMedia(chatId: string, media: OutgoingMedia): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
}
