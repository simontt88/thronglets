import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface ClaudeCodeRuntimeConfig {
  model?: string;
  apiKey?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

class ClaudeCodeSession implements AgentSession {
  private config: ClaudeCodeRuntimeConfig;
  private cwd: string;
  private model: string;
  private sessionId: string | null = null;
  private queryFn: (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;

  constructor(
    queryFn: (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>,
    config: ClaudeCodeRuntimeConfig,
    cwd: string,
    model: string,
  ) {
    this.queryFn = queryFn;
    this.config = config;
    this.cwd = cwd;
    this.model = model;
  }

  async send(text: string): Promise<string> {
    const options: Record<string, unknown> = {
      model: this.model,
      cwd: this.cwd,
      permissionMode: this.config.permissionMode || "bypassPermissions",
    };

    if (this.config.allowedTools?.length) {
      options.allowedTools = this.config.allowedTools;
    }
    if (this.config.disallowedTools?.length) {
      options.disallowedTools = this.config.disallowedTools;
    }
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const queryOpts: Record<string, unknown> = { prompt: text, options };

    let result = "";
    for await (const message of this.queryFn(queryOpts)) {
      const msg = message as { type?: string; subtype?: string; result?: string; session_id?: string; data?: { session_id?: string } };

      // Capture session ID for multi-turn
      if (msg.type === "system" && msg.subtype === "init" && msg.data?.session_id) {
        this.sessionId = msg.data.session_id;
      }
      if (msg.session_id && !this.sessionId) {
        this.sessionId = msg.session_id;
      }

      // Capture the final result
      if ("result" in msg && typeof msg.result === "string") {
        result = msg.result;
      }
    }

    return result || "(no response)";
  }

  close(): void {
    this.sessionId = null;
  }
}

export class ClaudeCodeRuntime implements Runtime {
  readonly name = "claude-code";

  constructor(private config: ClaudeCodeRuntimeConfig) {}

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    // Set ANTHROPIC_API_KEY for the SDK
    if (this.config.apiKey) {
      process.env.ANTHROPIC_API_KEY = this.config.apiKey;
    }

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const model = opts.model || this.config.model || "claude-sonnet-4-6";
    return new ClaudeCodeSession(
      query as unknown as (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>,
      this.config,
      opts.cwd,
      model,
    );
  }
}
