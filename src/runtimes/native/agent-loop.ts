/**
 * Native agent loop — Phase F: the self-hosted tool-execution cycle.
 *
 * Instead of delegating to a vendor SDK (codex-sdk / claude-agent-sdk), Thronglets
 * runs the loop itself: call the model → parse tool calls → execute them locally →
 * feed results back → repeat until the model returns a final answer.
 *
 * Because we own the loop, telemetry is emitted *directly* to the fleet bus — no
 * proxy, no SSE reconstruction, no [GATEWAY_AGENT] marker. Dispatch + gamification
 * subscribe to the same tool_call / tool_result / usage / model_switch events they
 * already consume from the gateway, so the native runtime lights up the dashboard
 * for free. And because the model is chosen per *step*, tier switching is truly
 * mid-task: a directive can swap small→large between two tool calls.
 */

import { directiveStore } from "../../gateway/directives.js";
import { resolveModel, type ApiProvider } from "../../gateway/models.js";
import { computeCost, persistTrace, type ThrongTrace, type UsageInfo } from "../../gateway/trace.js";
import { NATIVE_TOOLS, TOOLS_BY_NAME, summarizeToolCall, type NativeTool, type ToolResult } from "./tools.js";

export interface BusLike {
  publish(type: string, agent: string, session: string, payload?: unknown): void;
}

interface ParsedTurn {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  model?: string;
  /** Provider-native assistant message to append to history. */
  assistantMessage: Record<string, unknown>;
}

type Msg = Record<string, unknown>;

/** Per-provider request/response translation. Keeps the loop provider-agnostic. */
interface ProviderAdapter {
  readonly path: string;
  headers(apiKey: string): Record<string, string>;
  toolSchemas(tools: NativeTool[]): unknown;
  userMessage(text: string): Msg;
  buildBody(model: string, system: string, history: Msg[], toolSchemas: unknown): Record<string, unknown>;
  parse(json: Record<string, unknown>): ParsedTurn;
  toolResultMessages(results: Array<{ id: string; result: ToolResult }>): Msg[];
}

// ─── OpenAI adapter (chat completions) ────────────────────────────────────────

const openAIAdapter: ProviderAdapter = {
  path: "/chat/completions",
  headers(apiKey) {
    return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  },
  toolSchemas(tools) {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  },
  userMessage(text) {
    return { role: "user", content: text };
  },
  buildBody(model, system, history, toolSchemas) {
    return {
      model,
      messages: [{ role: "system", content: system }, ...history],
      tools: toolSchemas,
      tool_choice: "auto",
      stream: false,
    };
  },
  parse(json) {
    const choices = (json.choices as Array<Record<string, unknown>>) || [];
    const message = (choices[0]?.message as Record<string, unknown>) || {};
    const text = typeof message.content === "string" ? message.content : "";
    const rawToolCalls = (message.tool_calls as Array<Record<string, unknown>>) || [];
    const toolCalls = rawToolCalls
      .filter((tc) => tc.type === "function")
      .map((tc) => {
        const fn = (tc.function as Record<string, unknown>) || {};
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(String(fn.arguments || "{}")); } catch {}
        return { id: String(tc.id || ""), name: String(fn.name || ""), input };
      });
    const u = json.usage as Record<string, unknown> | undefined;
    const pd = u?.prompt_tokens_details as Record<string, unknown> | undefined;
    const usage = u
      ? {
          inputTokens: Number(u.prompt_tokens ?? 0),
          outputTokens: Number(u.completion_tokens ?? 0),
          cachedTokens: Number(pd?.cached_tokens ?? 0),
        }
      : undefined;
    return { text, toolCalls, usage, model: String(json.model || ""), assistantMessage: message };
  },
  toolResultMessages(results) {
    return results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.result.content }));
  },
};

// ─── Anthropic adapter (messages) ─────────────────────────────────────────────

const MAX_TOKENS = 4096;

const anthropicAdapter: ProviderAdapter = {
  path: "/messages",
  headers(apiKey) {
    return { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  },
  toolSchemas(tools) {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  },
  userMessage(text) {
    return { role: "user", content: text };
  },
  buildBody(model, system, history, toolSchemas) {
    return { model, max_tokens: MAX_TOKENS, system, messages: history, tools: toolSchemas, stream: false };
  },
  parse(json) {
    const content = (json.content as Array<Record<string, unknown>>) || [];
    let text = "";
    const toolCalls: ParsedTurn["toolCalls"] = [];
    for (const block of content) {
      if (block.type === "text") text += String(block.text || "");
      else if (block.type === "tool_use") {
        toolCalls.push({ id: String(block.id || ""), name: String(block.name || ""), input: (block.input as Record<string, unknown>) || {} });
      }
    }
    const u = json.usage as Record<string, unknown> | undefined;
    const usage = u
      ? {
          inputTokens: Number(u.input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
          cachedTokens: Number(u.cache_read_input_tokens ?? 0),
        }
      : undefined;
    return { text, toolCalls, usage, model: String(json.model || ""), assistantMessage: { role: "assistant", content } };
  },
  toolResultMessages(results) {
    return [
      {
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.result.content,
          is_error: !r.result.ok,
        })),
      },
    ];
  },
};

function adapterFor(provider: ApiProvider): ProviderAdapter {
  return provider === "anthropic" ? anthropicAdapter : openAIAdapter;
}

// ─── The loop ─────────────────────────────────────────────────────────────────

/** A transport sends a request body to the model and returns the raw JSON response. */
export type Transport = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface AgentLoopOptions {
  agent: string;
  session: string;
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  cwd: string;
  systemPrompt: string;
  bus?: BusLike;
  tools?: NativeTool[];
  maxSteps?: number;
  /** Override the HTTP transport (used in tests to avoid real API calls). */
  transport?: Transport;
}

export class AgentLoop {
  private readonly o: Required<Pick<AgentLoopOptions, "agent" | "session" | "provider" | "apiKey" | "baseUrl" | "cwd" | "systemPrompt">> &
    AgentLoopOptions;
  private readonly adapter: ProviderAdapter;
  private readonly tools: NativeTool[];
  private readonly toolSchemas: unknown;
  private readonly transport: Transport;
  private readonly maxSteps: number;
  private currentModel: string;
  private history: Msg[] = [];

  constructor(opts: AgentLoopOptions) {
    this.o = opts as AgentLoop["o"];
    this.adapter = adapterFor(opts.provider);
    this.tools = opts.tools || NATIVE_TOOLS;
    this.toolSchemas = this.adapter.toolSchemas(this.tools);
    this.currentModel = opts.model;
    this.maxSteps = opts.maxSteps ?? 25;
    this.transport = opts.transport || this.makeHttpTransport();
  }

  private makeHttpTransport(): Transport {
    const url = `${this.o.baseUrl}${this.adapter.path}`;
    const headers = this.adapter.headers(this.o.apiKey);
    return async (body) => {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`${this.o.provider} ${resp.status}: ${t.slice(0, 400)}`);
      }
      return (await resp.json()) as Record<string, unknown>;
    };
  }

  /** Run one user turn to completion (model answers, possibly after several tool calls). */
  async run(userText: string): Promise<string> {
    this.history.push(this.adapter.userMessage(userText));
    let finalText = "";

    for (let step = 0; step < this.maxSteps; step++) {
      this.applyTierDirective();

      const body = this.adapter.buildBody(this.currentModel, this.o.systemPrompt, this.history, this.toolSchemas);
      const startedAt = Date.now();
      const json = await this.transport(body);
      const turn = this.adapter.parse(json);

      if (turn.usage) this.emitUsage(turn.usage, turn.model || this.currentModel, Date.now() - startedAt);

      this.history.push(turn.assistantMessage);

      if (turn.toolCalls.length === 0) {
        return turn.text || finalText || "(no response)";
      }
      finalText = turn.text || finalText;

      const results: Array<{ id: string; result: ToolResult }> = [];
      for (const call of turn.toolCalls) {
        this.emitToolCall(call);
        const tool: NativeTool | undefined = TOOLS_BY_NAME[call.name];
        const result = tool
          ? await tool.run(call.input, this.o.cwd).catch((e) => ({ ok: false, content: `tool error: ${(e as Error).message}` }))
          : { ok: false, content: `unknown tool: ${call.name}` };
        this.emitToolResult(call.id, result);
        results.push({ id: call.id, result });
      }
      this.history.push(...this.adapter.toolResultMessages(results));
    }

    return finalText || `(reached max steps: ${this.maxSteps})`;
  }

  // ─── Per-step model tier switching ──────────────────────────────────────────

  private applyTierDirective(): void {
    const tier = directiveStore.consumeTier(this.o.agent);
    if (!tier) return;
    const target = resolveModel(this.o.provider, tier);
    if (!target || target === this.currentModel) return;
    const from = this.currentModel;
    this.currentModel = target;
    this.o.bus?.publish("model_switch", this.o.agent, this.o.session, { from, to: target, tier });
    console.log(`[native/${this.o.provider}] ${this.o.agent} model switch → ${tier} (${from} → ${target})`);
  }

  // ─── Telemetry (direct to bus + JSONL persistence) ──────────────────────────

  private emit(kind: ThrongTrace["kind"], partial: Partial<ThrongTrace>): void {
    this.o.bus?.publish(kind, this.o.agent, this.o.session, partial);
    persistTrace({
      agent: this.o.agent,
      session: this.o.session,
      ts: new Date().toISOString(),
      kind,
      provider: this.o.provider,
      ...partial,
    });
  }

  private emitToolCall(call: { id: string; name: string; input: Record<string, unknown> }): void {
    const summary = summarizeToolCall(call.name, call.input);
    this.emit("tool_call", { tool: { id: call.id, name: call.name, input: call.input, summary } });
    console.log(`[native/${this.o.provider}] ${this.o.agent} → ${call.name} | ${summary}`);
  }

  private emitToolResult(toolId: string, result: ToolResult): void {
    this.emit("tool_result", { result: { toolId, ok: result.ok, preview: result.content.slice(0, 200) } });
  }

  private emitUsage(usage: { inputTokens: number; outputTokens: number; cachedTokens: number }, model: string, latencyMs: number): void {
    const costUsd = computeCost(model, usage.inputTokens, usage.outputTokens, usage.cachedTokens);
    const full: UsageInfo = { ...usage, model, costUsd, latencyMs };
    this.emit("usage", { usage: full });
    console.log(`[native/${this.o.provider}] ${this.o.agent} usage: ${usage.inputTokens}in/${usage.outputTokens}out $${costUsd.toFixed(5)} ${latencyMs}ms (${model})`);
  }
}
