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

    const model = opts.model || this.config.model || "gpt-4o-mini";
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || "";

    // Point to our OpenAI gateway for tool_call observation
    // Disable with THRONGLETS_GATEWAY_ENABLED=false
    const gatewayEnabled = process.env.THRONGLETS_GATEWAY_ENABLED !== "false";
    if (gatewayEnabled) {
      process.env.OPENAI_BASE_URL = "http://127.0.0.1:3847/gateway/openai";
      console.log(`[codex] gateway enabled: http://127.0.0.1:3847/gateway/openai`);
    }

    const codex = new Codex({
      apiKey,
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
