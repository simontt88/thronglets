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
  private agentName: string;
  private queryFn: (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;

  constructor(
    queryFn: (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>,
    config: ClaudeCodeRuntimeConfig,
    cwd: string,
    model: string,
    agentName: string = "unknown",
  ) {
    this.queryFn = queryFn;
    this.config = config;
    this.cwd = cwd;
    this.model = model;
    this.agentName = agentName;
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

    // Inject agent identifier for gateway tracking (will be parsed by proxy)
    // Format: [GATEWAY_AGENT:agentname|sessionid] at the very start
    const agentMarker = `[GATEWAY_AGENT:${this.agentName || "unknown"}|${this.sessionId || "session"}]`;
    const injectedText = agentMarker + "\n" + text;

    const queryOpts: Record<string, unknown> = { prompt: injectedText, options };

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

    // Set ANTHROPIC_BASE_URL to point to our gateway (localhost:3847/gateway)
    // if THRONGLETS_GATEWAY_ENABLED=true (default: true)
    // Gateway intercepts tool_use calls and emits events for dashboard visualization
    // Disable with: THRONGLETS_GATEWAY_ENABLED=false
    const gatewayEnabled = process.env.THRONGLETS_GATEWAY_ENABLED !== "false";
    if (gatewayEnabled) {
      process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3847/gateway";
      console.log(`[claude-code] gateway enabled: http://127.0.0.1:3847/gateway`);
    }

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const model = opts.model || this.config.model || "claude-haiku-4-5-20251001";
    return new ClaudeCodeSession(
      query as unknown as (opts: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>,
      this.config,
      opts.cwd,
      model,
      opts.name || "unknown",
    );
  }
}
