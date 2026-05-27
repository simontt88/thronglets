import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface CodexRuntimeConfig {
  model?: string;
  apiKey?: string;
  approvalPolicy?: string;
}

class CodexSession implements AgentSession {
  private thread: { run: (prompt: string) => Promise<{ finalResponse?: string; items?: unknown[] }> };

  constructor(thread: { run: (prompt: string) => Promise<{ finalResponse?: string; items?: unknown[] }> }) {
    this.thread = thread;
  }

  async send(text: string): Promise<string> {
    const result = await this.thread.run(text);
    return result.finalResponse || "(no response)";
  }

  close(): void {}
}

export class CodexRuntime implements Runtime {
  readonly name = "codex";

  constructor(private config: CodexRuntimeConfig) {}

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    const { Codex } = await import("@openai/codex-sdk");

    const model = opts.model || this.config.model || "o4-mini";

    const codex = new Codex({
      apiKey: this.config.apiKey || process.env.OPENAI_API_KEY,
      config: { model },
    });

    const thread = codex.startThread({
      cwd: opts.cwd,
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });

    return new CodexSession(thread);
  }
}
