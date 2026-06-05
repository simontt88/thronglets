import express, { Request, Response } from "express";
import type { FleetEventBus } from "../fleet/manager.js";
import { directiveStore } from "./directives.js";
import { resolveModel, type ApiProvider } from "./models.js";
import { StreamAccumulator } from "./sse.js";
import { computeCost, persistTrace, type ThrongTrace, type UsageInfo } from "./trace.js";

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

interface GatewayConfig {
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  apiVersion?: string;
}

/** Minimal structural type for the upstream fetch Response (avoids express.Response name clash). */
interface UpstreamResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  json: () => Promise<Record<string, unknown>>;
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

  private emit(kind: ThrongTrace["kind"], partial: Partial<ThrongTrace>): void {
    const trace: ThrongTrace = {
      agent: this.agentName,
      session: this.sessionId,
      ts: new Date().toISOString(),
      kind,
      provider: this.cfg.provider,
      ...partial,
    };
    this.bus.publish(kind, this.agentName, this.sessionId, partial);
    persistTrace(trace);
  }

  private emitToolCalls(calls: ToolCall[]): void {
    for (const call of calls) {
      const summary = summarizeToolCall(call.name, call.input);
      this.emit("tool_call", { tool: { id: call.id, name: call.name, input: call.input, summary } });
      console.log(`[gateway/${this.cfg.provider}] ${this.agentName} → ${call.name} (${(call.id || "").slice(0, 8)}) | ${summary}`);
    }
  }

  private emitUsage(usage: { inputTokens: number; outputTokens: number; cachedTokens: number }, model: string, latencyMs: number): void {
    const costUsd = computeCost(model, usage.inputTokens, usage.outputTokens, usage.cachedTokens);
    const full: UsageInfo = { ...usage, model, costUsd, latencyMs };
    this.emit("usage", { usage: full });
    console.log(`[gateway/${this.cfg.provider}] ${this.agentName} usage: ${usage.inputTokens}in/${usage.outputTokens}out $${costUsd.toFixed(5)} ${latencyMs}ms (${model})`);
  }

  /** Parse tool results carried back in the request body (the outcome of prior tool calls). */
  private emitToolResultsFromRequest(body: Record<string, unknown>): void {
    const messages = body.messages as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(messages)) return;
    // Only look at the last message wave to avoid re-emitting the whole history each turn
    const tail = messages.slice(-4);
    for (const m of tail) {
      if (this.cfg.provider === "openai" && m.role === "tool") {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        const ok = !/error|exception|traceback|fail/i.test(content.slice(0, 200));
        this.emit("tool_result", { result: { toolId: String(m.tool_call_id || ""), ok, preview: content.slice(0, 200) } });
      } else if (this.cfg.provider === "anthropic" && m.role === "user" && Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_result") {
            const c = block.content;
            const text = typeof c === "string" ? c : JSON.stringify(c);
            const ok = block.is_error !== true;
            this.emit("tool_result", { result: { toolId: String(block.tool_use_id || ""), ok, preview: text.slice(0, 200) } });
          }
        }
      }
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

  /**
   * Apply a per-agent model directive: rewrite body.model to the resolved
   * model for the agent's active tier. Returns the (possibly mutated) body.
   */
  private applyModelDirective(body: Record<string, unknown>): Record<string, unknown> {
    if (this.agentName === "unknown") return body;
    const tier = directiveStore.consumeTier(this.agentName);
    if (!tier) return body;

    const targetModel = resolveModel(this.cfg.provider, tier);
    const currentModel = body.model as string | undefined;
    if (!targetModel || targetModel === currentModel) return body;

    body.model = targetModel;
    this.bus.publish("model_switch", this.agentName, this.sessionId, {
      from: currentModel,
      to: targetModel,
      tier,
    });
    console.log(`[gateway/${this.cfg.provider}] ${this.agentName} model switch → ${tier} (${currentModel} → ${targetModel})`);
    return body;
  }

  /** Remove the [GATEWAY_AGENT:...] marker so the model never sees it. */
  private stripMarker(body: Record<string, unknown>): void {
    const messages = body.messages as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (typeof m.content === "string") {
        m.content = m.content.replace(/\[GATEWAY_AGENT:[^\]]+\]\n?/g, "");
      } else if (Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string") {
            block.text = block.text.replace(/\[GATEWAY_AGENT:[^\]]+\]\n?/g, "");
          }
        }
      }
    }
  }

  /** For OpenAI streaming, ask upstream to include usage in the final chunk. */
  private ensureUsageReporting(body: Record<string, unknown>): void {
    if (this.cfg.provider === "openai" && body.stream === true) {
      const opts = (body.stream_options as Record<string, unknown>) || {};
      opts.include_usage = true;
      body.stream_options = opts;
    }
  }

  async handle(req: Request, res: Response): Promise<void> {
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    const url = `${this.cfg.baseUrl}${path}`;

    let body = req.body as Record<string, unknown>;
    const isPost = req.method === "POST" && body && typeof body === "object";

    if (isPost) {
      this.stripMarker(body);
      this.emitToolResultsFromRequest(body);     // outcomes of prior tool calls
      body = this.applyModelDirective(body);      // per-task model switching
      this.ensureUsageReporting(body);
    }

    const wantsStream = isPost && body.stream === true;
    const startedAt = Date.now();

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers: this.buildHeaders(req.headers),
        body: req.method !== "GET" ? JSON.stringify(body) : undefined,
      });

      if (wantsStream && upstream.body) {
        await this.pipeStream(upstream, res, startedAt);
      } else {
        await this.handleJson(upstream, req, res, startedAt);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway/${this.cfg.provider}] proxy error for ${this.agentName}: ${msg}`);
      this.emit("error", { error: { type: "gateway_error", message: msg } });
      if (!res.headersSent) {
        res.status(502).json({ type: "error", error: { type: "gateway_error", message: msg } });
      } else {
        res.end();
      }
    }
  }

  /** Stream branch: pipe SSE chunks to the agent unchanged while tee-ing to a parser. */
  private async pipeStream(upstream: UpstreamResponse, res: Response, startedAt: number): Promise<void> {
    res.status((upstream as unknown as { status: number }).status);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");

    const acc = new StreamAccumulator(this.cfg.provider);
    const decoder = new TextDecoder();
    const reader = ((upstream as unknown as { body: ReadableStream<Uint8Array> }).body).getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);          // forward to agent immediately — never block it
        acc.push(chunk);           // tee into the parser
      }
    } finally {
      res.end();
    }

    const parsed = acc.finish();
    if (parsed.toolCalls.length) {
      this.emitToolCalls(parsed.toolCalls.map((t) => ({ ...t, timestamp: new Date().toISOString() })));
    }
    if (parsed.usage && parsed.model) {
      this.emitUsage(parsed.usage, parsed.model, Date.now() - startedAt);
    }
  }

  /** Non-streaming branch: buffer JSON, parse tool calls + usage, forward. */
  private async handleJson(upstream: UpstreamResponse, req: Request, res: Response, startedAt: number): Promise<void> {
    const data = await (upstream as unknown as { json: () => Promise<Record<string, unknown>> }).json();
    const status = (upstream as unknown as { status: number }).status;

    if (req.method === "POST") {
      if (this.cfg.provider === "anthropic" && req.path === "/messages") {
        const calls = parseAnthropicToolUses(data.content as unknown[]);
        if (calls.length) this.emitToolCalls(calls);
        const u = data.usage as Record<string, unknown> | undefined;
        if (u) {
          this.emitUsage({
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cachedTokens: Number(u.cache_read_input_tokens ?? 0),
          }, String(data.model || ""), Date.now() - startedAt);
        }
      } else if (this.cfg.provider === "openai" && req.path.endsWith("/chat/completions")) {
        const calls = parseOpenAIToolCalls(data.choices as unknown[]);
        if (calls.length) this.emitToolCalls(calls);
        const u = data.usage as Record<string, unknown> | undefined;
        if (u) {
          const pd = u.prompt_tokens_details as Record<string, unknown> | undefined;
          this.emitUsage({
            inputTokens: Number(u.prompt_tokens ?? 0),
            outputTokens: Number(u.completion_tokens ?? 0),
            cachedTokens: Number(pd?.cached_tokens ?? 0),
          }, String(data.model || ""), Date.now() - startedAt);
        }
      }
    }

    res.status(status).json(data);
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
