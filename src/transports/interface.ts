export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  username?: string;
  isCommand?: boolean;
  raw?: unknown;
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
  sendTyping(chatId: string): Promise<void>;
}
