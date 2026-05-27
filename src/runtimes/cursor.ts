import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface CursorRuntimeConfig {
  apiKey: string;
  model: string;
}

const SEND_CALL_TIMEOUT_MS = 60 * 1000; // 60s for the SDK send() call itself
const WAIT_TIMEOUT_MS = parseInt(process.env.BRIDGE_CURSOR_WAIT_MS || "", 10) || 60 * 60 * 1000; // default 1h (3600000ms); override via BRIDGE_CURSOR_WAIT_MS env

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
  private busy = false;

  constructor(agent: { send: (text: string, opts?: Record<string, unknown>) => Promise<SDKRun>; close: () => void }) {
    this.agent = agent;
  }

  async send(text: string): Promise<string> {
    if (!this.alive) {
      throw new Error("Session closed — create a new one");
    }
    if (this.busy) {
      throw new Error("Session busy — concurrent send() calls are not supported");
    }

    this.busy = true;
    try {
      return await this.doSend(text);
    } finally {
      this.busy = false;
    }
  }

  private async doSend(text: string): Promise<string> {
    let run: SDKRun;
    try {
      run = await Promise.race([
        this.agent.send(text),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Cursor SDK send() hung — no run object within timeout")), SEND_CALL_TIMEOUT_MS)
        ),
      ]);
    } catch (sendErr) {
      this.alive = false;
      throw new Error(`Cursor SDK send() failed: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run.wait(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            run.cancel?.().catch(() => {});
            reject(new Error("Cursor SDK wait() hung — no response within timeout"));
          }, WAIT_TIMEOUT_MS);
        }),
      ]);

      if (result.status === "error") {
        const detail = JSON.stringify(result).slice(0, 800);
        throw new Error(`Cursor run failed (status=error, id=${result.id ?? "?"}): ${detail}`);
      }
      if (result.status === "cancelled") {
        throw new Error(`Cursor run was cancelled (id=${result.id ?? "?"})`);
      }
      if (!result.result) {
        const detail = JSON.stringify(result).slice(0, 800);
        throw new Error(`Cursor returned empty result: ${detail}`);
      }
      return result.result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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
