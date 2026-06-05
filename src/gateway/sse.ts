/**
 * SSE stream parsing for the gateway.
 *
 * Real agents (Codex / Claude Code SDKs) request `stream: true`, so the upstream
 * response is a Server-Sent Events stream. The gateway must pipe every chunk to
 * the agent unchanged (don't break the agent) while teeing the bytes into a
 * parser that reconstructs tool_calls and usage from the deltas.
 */

import type { ApiProvider } from "./models.js";

export interface ParsedStream {
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
  model?: string;
}

/**
 * Accumulates SSE chunks and reconstructs tool calls + usage.
 * Feed raw decoded text via push(); call finish() to get the result.
 */
export class StreamAccumulator {
  private buffer = "";
  private provider: ApiProvider;

  // OpenAI: tool_calls arrive as indexed delta fragments
  private oaiTools = new Map<number, { id: string; name: string; args: string }>();
  // Anthropic: content blocks keyed by index
  private antTools = new Map<number, { id: string; name: string; json: string }>();

  private usage: ParsedStream["usage"];
  private model?: string;

  constructor(provider: ApiProvider) {
    this.provider = provider;
  }

  push(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    // Keep the last (possibly partial) line in the buffer
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]" || !data) continue;
      try {
        const json = JSON.parse(data);
        if (this.provider === "openai") this.handleOpenAI(json);
        else this.handleAnthropic(json);
      } catch {
        // partial / non-JSON SSE line — ignore
      }
    }
  }

  private handleOpenAI(json: Record<string, unknown>): void {
    if (json.model) this.model = String(json.model);
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const idx = Number(tc.index ?? 0);
            const existing = this.oaiTools.get(idx) || { id: "", name: "", args: "" };
            if (tc.id) existing.id = String(tc.id);
            const fn = tc.function as Record<string, unknown> | undefined;
            if (fn?.name) existing.name = String(fn.name);
            if (fn?.arguments) existing.args += String(fn.arguments);
            this.oaiTools.set(idx, existing);
          }
        }
      }
    }
    const usage = json.usage as Record<string, unknown> | undefined;
    if (usage) {
      const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
      this.usage = {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        cachedTokens: Number(promptDetails?.cached_tokens ?? 0),
      };
    }
  }

  private handleAnthropic(json: Record<string, unknown>): void {
    const type = json.type as string | undefined;
    if (type === "message_start") {
      const msg = json.message as Record<string, unknown> | undefined;
      if (msg?.model) this.model = String(msg.model);
      const u = msg?.usage as Record<string, unknown> | undefined;
      if (u) {
        this.usage = {
          inputTokens: Number(u.input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
          cachedTokens: Number(u.cache_read_input_tokens ?? 0),
        };
      }
    } else if (type === "content_block_start") {
      const idx = Number(json.index ?? 0);
      const block = json.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        this.antTools.set(idx, { id: String(block.id || ""), name: String(block.name || ""), json: "" });
      }
    } else if (type === "content_block_delta") {
      const idx = Number(json.index ?? 0);
      const delta = json.delta as Record<string, unknown> | undefined;
      if (delta?.type === "input_json_delta" && this.antTools.has(idx)) {
        this.antTools.get(idx)!.json += String(delta.partial_json || "");
      }
    } else if (type === "message_delta") {
      const u = json.usage as Record<string, unknown> | undefined;
      if (u && this.usage) {
        this.usage.outputTokens = Number(u.output_tokens ?? this.usage.outputTokens);
      }
    }
  }

  finish(): ParsedStream {
    const toolCalls: ParsedStream["toolCalls"] = [];

    for (const t of this.oaiTools.values()) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(t.args || "{}"); } catch {}
      toolCalls.push({ id: t.id, name: t.name, input });
    }
    for (const t of this.antTools.values()) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(t.json || "{}"); } catch {}
      toolCalls.push({ id: t.id, name: t.name, input });
    }

    return { toolCalls, usage: this.usage, model: this.model };
  }
}
