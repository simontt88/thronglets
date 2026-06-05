import express, { Request, Response } from "express";
import type { FleetEventBus } from "../fleet/manager.js";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}

// ─── Tool call summarizer ─────────────────────────────────────────────────────

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
    case "str_replace_based_edit_tool":
      return `📖 ${input.path || input.file_path || "?"}`;
    case "write_file":
    case "create_file":
      return `✏️ ${input.path || "?"}`;
    case "bash":
    case "execute_bash":
    case "computer":
      return `▶️ ${String(input.command || input.input || "").split("\n")[0].slice(0, 60)}`;
    case "grep":
    case "search_files":
      return `🔍 ${input.pattern || input.query || "?"}`;
    case "glob":
    case "list_directory":
      return `📁 ${input.pattern || input.path || "?"}`;
    default:
      return `🔧 ${name}`;
  }
}

// ─── Anthropic format handler ─────────────────────────────────────────────────

function parseAnthropicToolUses(content: unknown[]): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCall[] = [];
  const timestamp = new Date().toISOString();

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && b.id && b.name) {
      calls.push({
        id: String(b.id),
        name: String(b.name),
        input: (b.input as Record<string, unknown>) || {},
        timestamp,
      });
    }
  }
  return calls;
}

// ─── OpenAI format handler ────────────────────────────────────────────────────

function parseOpenAIToolCalls(choices: unknown[]): ToolCall[] {
  if (!Array.isArray(choices)) return [];
  const calls: ToolCall[] = [];
  const timestamp = new Date().toISOString();

  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const c = choice as Record<string, unknown>;
    const msg = c.message as Record<string, unknown> | undefined;
    const toolCalls = msg?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(toolCalls)) continue;

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (!fn) continue;
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(String(fn.arguments || "{}"));
      } catch {}
      calls.push({
        id: String(tc.id || ""),
        name: String(fn.name || ""),
        input: parsedArgs,
        timestamp,
      });
    }
  }
  return calls;
}

// ─── Gateway ─────────────────────────────────────────────────────────────────

type ApiProvider = "anthropic" | "openai";

interface GatewayConfig {
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  apiVersion?: string;
}

class ApiGateway {
  private bus: FleetEventBus;
  private agentName: string;
  private sessionId: string;
  private cfg: GatewayConfig;

  constructor(cfg: GatewayConfig, bus: FleetEventBus, agentName: string, sessionId: string = "gateway") {
    this.cfg = cfg;
    this.bus = bus;
    this.agentName = agentName;
    this.sessionId = sessionId;
  }

  private emitToolCalls(calls: ToolCall[]): void {
    for (const call of calls) {
      const summary = summarizeToolCall(call.name, call.input);
      this.bus.publish("tool_call", this.agentName, this.sessionId, {
        toolName: call.name,
        toolId: call.id,
        summary,
        input: call.input,
      });
      console.log(`[gateway/${this.cfg.provider}] ${this.agentName} → ${call.name} (${call.id.slice(0, 8)}) | ${summary}`);
    }
  }

  private buildHeaders(reqHeaders: Request["headers"]): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };

    if (this.cfg.provider === "anthropic") {
      h["x-api-key"] = this.cfg.apiKey;
      h["anthropic-version"] = this.cfg.apiVersion || "2023-06-01";
      const beta = reqHeaders["anthropic-beta"];
      if (beta) h["anthropic-beta"] = String(beta);
    } else {
      h["authorization"] = `Bearer ${this.cfg.apiKey}`;
      const orgId = reqHeaders["openai-organization"];
      if (orgId) h["openai-organization"] = String(orgId);
    }

    return h;
  }

  async handle(req: Request, res: Response): Promise<void> {
    // Build upstream URL
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    const url = `${this.cfg.baseUrl}${path}`;

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers: this.buildHeaders(req.headers),
        body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
      });

      const data = await upstream.json();

      // Parse tool calls based on provider format
      if (req.method === "POST") {
        if (this.cfg.provider === "anthropic" && req.path === "/messages") {
          const calls = parseAnthropicToolUses(data.content as unknown[]);
          if (calls.length) this.emitToolCalls(calls);
        } else if (this.cfg.provider === "openai" && req.path.endsWith("/chat/completions")) {
          const calls = parseOpenAIToolCalls(data.choices as unknown[]);
          if (calls.length) this.emitToolCalls(calls);
        }
      }

      res.status(upstream.status).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway/${this.cfg.provider}] proxy error for ${this.agentName}: ${msg}`);
      res.status(502).json({ type: "error", error: { type: "gateway_error", message: msg } });
    }
  }
}

// ─── Extract agent identity from request body ─────────────────────────────────

function extractAgent(body: Record<string, unknown>): { agentName: string; sessionId: string } {
  // Check Anthropic format: first user message content
  const messages = (body.messages || body.input) as Array<{ role?: string; content?: unknown }> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return { agentName: "unknown", sessionId: "unknown" };

  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return { agentName: "unknown", sessionId: "unknown" };

  const content = firstUser.content;
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const block = (content as Array<{ type?: string; text?: string }>).find((b) => b.type === "text");
    text = block?.text || "";
  }

  const match = text.match(/\[GATEWAY_AGENT:([^|]+)\|([^\]]+)\]/);
  if (match) return { agentName: match[1], sessionId: match[2] };

  return { agentName: "unknown", sessionId: "unknown" };
}

// ─── Router factories ─────────────────────────────────────────────────────────

function makeRouter(cfg: GatewayConfig, bus: FleetEventBus): express.Router {
  const router = express.Router();
  const gateways = new Map<string, ApiGateway>();

  router.all(/.*/, async (req, res) => {
    const { agentName, sessionId } = extractAgent(req.body as Record<string, unknown>);

    if (!gateways.has(agentName)) {
      gateways.set(agentName, new ApiGateway(cfg, bus, agentName, sessionId));
    }

    await gateways.get(agentName)!.handle(req, res);
  });

  return router;
}

export function createAnthropicGatewayRouter(bus: FleetEventBus, apiKey: string): express.Router {
  return makeRouter({
    provider: "anthropic",
    apiKey,
    baseUrl: "https://api.anthropic.com/v1",
    apiVersion: "2023-06-01",
  }, bus);
}

export function createOpenAIGatewayRouter(bus: FleetEventBus, apiKey: string): express.Router {
  return makeRouter({
    provider: "openai",
    apiKey,
    baseUrl: "https://api.openai.com/v1",
  }, bus);
}

// Keep backward-compat export
export function createGatewayRouter(bus: FleetEventBus, apiKey: string): express.Router {
  return createAnthropicGatewayRouter(bus, apiKey);
}
