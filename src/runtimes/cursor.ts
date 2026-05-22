import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface CursorRuntimeConfig {
  apiKey: string;
  model: string;
}

class CursorSession implements AgentSession {
  private agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<{ wait: () => Promise<{ result?: string }> }>; close: () => void };

  constructor(agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<{ wait: () => Promise<{ result?: string }> }>; close: () => void }) {
    this.agent = agent;
  }

  async send(text: string): Promise<string> {
    const run = await this.agent.send(text);
    const result = await run.wait();
    return result.result || "(no response)";
  }

  close(): void {
    try { this.agent.close(); } catch {}
  }
}

export class CursorRuntime implements Runtime {
  readonly name = "cursor";

  constructor(private config: CursorRuntimeConfig) {}

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    let sdk: Record<string, unknown>;
    try {
      sdk = await import("@cursor/sdk");
    } catch {
      throw new Error("Cursor SDK not installed. Run: npm install @cursor/sdk");
    }

    const AgentClass = (sdk.Agent || sdk.default) as {
      create: (opts: Record<string, unknown>) => Promise<{
        send: (text: string, opts?: Record<string, unknown>) => Promise<{ wait: () => Promise<{ result?: string }> }>;
        close: () => void;
      }>;
    };

    const agent = await AgentClass.create({
      apiKey: this.config.apiKey,
      model: { id: opts.model || this.config.model },
      name: opts.name || `bridge-${Date.now().toString(36)}`,
      local: { cwd: opts.cwd },
    });

    return new CursorSession(agent);
  }
}
