import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface CursorRuntimeConfig {
  apiKey: string;
  model: string;
}

const PER_STEP_TIMEOUT_MS = 4.5 * 60 * 1000; // 4.5 min per SDK call (before fleet-level timeout)

interface RunResult {
  id?: string;
  status?: "finished" | "error" | "cancelled";
  result?: string;
  durationMs?: number;
}

interface SDKRun {
  wait: () => Promise<RunResult>;
  stream?: () => AsyncGenerator<unknown, void>;
  cancel?: () => Promise<void>;
  readonly status?: string;
}

class CursorSession implements AgentSession {
  private agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<SDKRun>; close: () => void };
  private alive = true;

  constructor(agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<SDKRun>; close: () => void }) {
    this.agent = agent;
  }

  async send(text: string): Promise<string> {
    if (!this.alive) {
      throw new Error("Session closed — create a new one");
    }

    let run: SDKRun;
    try {
      run = await this.agent.send(text);
    } catch (sendErr) {
      this.alive = false;
      throw new Error(`Cursor SDK send() failed (session likely stale): ${sendErr instanceof Error ? sendErr.message : sendErr}`);
    }

    const result = await Promise.race([
      run.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Cursor SDK wait() hung — no response within timeout")), PER_STEP_TIMEOUT_MS)
      ),
    ]);

    if (result.status === "error") {
      throw new Error(`Cursor run failed (status=error, id=${result.id ?? "?"})`);
    }
    if (result.status === "cancelled") {
      throw new Error(`Cursor run was cancelled (id=${result.id ?? "?"})`);
    }
    if (!result.result) {
      const detail = JSON.stringify({ status: result.status, id: result.id, durationMs: result.durationMs });
      throw new Error(`Cursor returned empty result: ${detail}`);
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
