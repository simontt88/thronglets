import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface CursorRuntimeConfig {
  apiKey: string;
  model: string;
}

const PER_STEP_TIMEOUT_MS = 4.5 * 60 * 1000; // 4.5 min per SDK call (before fleet-level timeout)

class CursorSession implements AgentSession {
  private agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<{ wait: () => Promise<{ result?: string }> }>; close: () => void };
  private alive = true;

  constructor(agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<{ wait: () => Promise<{ result?: string }> }>; close: () => void }) {
    this.agent = agent;
  }

  async send(text: string): Promise<string> {
    if (!this.alive) {
      throw new Error("Session already closed — create a new one");
    }

    const run = await this.agent.send(text);

    // Race the wait() against a timeout to prevent infinite hangs
    const result = await Promise.race([
      run.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Cursor SDK wait() hung — no response within timeout")), PER_STEP_TIMEOUT_MS)
      ),
    ]);

    if (!result.result) {
      throw new Error("Cursor session returned empty response — connection may be stale");
    }
    return result.result;
  }

  close(): void {
    this.alive = false;
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
