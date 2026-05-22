// Ambient module declarations for optional peer dependencies.
// These are dynamically imported at runtime — users install only what they need.

declare module "@anthropic-ai/claude-code-sdk" {
  export class ClaudeSDKClient {
    constructor(opts: Record<string, unknown>);
    query(opts: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
    close(): void;
  }
  export function query(opts: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}

declare module "@openai/codex-sdk" {
  export class Codex {
    constructor(opts?: Record<string, unknown>);
    startThread(opts?: Record<string, unknown>): {
      run(prompt: string, opts?: Record<string, unknown>): Promise<{ finalResponse?: string }>;
    };
  }
}

declare module "@larksuiteoapi/node-sdk" {
  export class Client {
    constructor(opts: Record<string, unknown>);
    im: { message: { create(opts: Record<string, unknown>): Promise<unknown> } };
  }
  export class WSClient {
    constructor(opts: Record<string, unknown>);
    start(opts: Record<string, unknown>): void;
  }
  export class EventDispatcher {
    constructor(opts: Record<string, unknown>);
    register(handlers: Record<string, (data: unknown) => Promise<void>>): this;
  }
  export const Domain: Record<string, string>;
  export const AppType: Record<string, string>;
}

declare module "discord.js" {
  export class Client {
    constructor(opts: Record<string, unknown>);
    on(event: string, handler: (...args: unknown[]) => void): void;
    login(token: string): Promise<void>;
    destroy(): void;
    channels: { fetch(id: string): Promise<{ isTextBased(): boolean; send(text: string): Promise<unknown>; sendTyping?(): Promise<void> } | null> };
  }
  export const GatewayIntentBits: Record<string, number>;
  export const Partials: Record<string, number>;
}
