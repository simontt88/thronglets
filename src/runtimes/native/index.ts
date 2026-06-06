/**
 * NativeRuntime — Phase F: Thronglets running its own agent, no vendor SDK.
 *
 * `runtime: native` in config selects this. It talks to the OpenAI/Anthropic API
 * directly and runs the tool-execution loop in-process (see agent-loop.ts),
 * emitting telemetry straight to the fleet bus. This is the "self-hosted" path:
 * full control of every turn, true mid-task model switching, and no SDK version lag.
 */

import type { Runtime, AgentSession, RuntimeSessionOptions } from "../interface.js";
import type { ApiProvider } from "../../gateway/models.js";
import { AgentLoop, type BusLike } from "./agent-loop.js";

export interface NativeRuntimeConfig {
  apiKey?: string;
  model?: string;
  /** Defaults inferred from the model id (claude* → anthropic, else openai). */
  provider?: ApiProvider;
  /** Override the upstream API base (e.g. for a proxy). */
  baseUrl?: string;
  /** Fleet bus — native publishes tool_call/tool_result/usage/model_switch here. */
  bus?: BusLike;
  maxSteps?: number;
}

const DEFAULT_BASE: Record<ApiProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

function inferProvider(model: string, explicit?: ApiProvider): ApiProvider {
  if (explicit) return explicit;
  return /^claude/i.test(model) ? "anthropic" : "openai";
}

const BASE_SYSTEM_PROMPT = [
  "You are a Thronglet — an autonomous coding agent working inside a real workspace on the user's machine.",
  "You complete tasks by calling tools: read_file, write_file, edit_file, list_dir, grep, and run_bash.",
  "For tasks about PAST work, search history, or session/token-cost analysis, the data lives in the cloud — use recall_sessions, list_session_workspaces, and get_session (VibeSync) rather than guessing or proposing.",
  "Work concretely: inspect the workspace (or query sessions) before answering, make focused changes, and verify with run_bash (build/tests) when relevant. Don't offer to 'draft a proposal' — gather the data and do the task.",
  "When the task is fully done, stop calling tools and reply with a short summary of what you did.",
].join("\n");

class NativeSession implements AgentSession {
  private alive = true;
  private busy = false;
  private loop: AgentLoop;

  constructor(loop: AgentLoop) {
    this.loop = loop;
  }

  async send(text: string): Promise<string> {
    if (!this.alive) throw new Error("Session closed — create a new one");
    if (this.busy) throw new Error("Session busy — concurrent send() not supported");
    this.busy = true;
    try {
      return await this.loop.run(text);
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    this.alive = false;
  }
}

export class NativeRuntime implements Runtime {
  readonly name = "native";

  constructor(private config: NativeRuntimeConfig) {}

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    const model = opts.model || this.config.model || "gpt-4o-mini";
    const provider = inferProvider(model, this.config.provider);
    const apiKey =
      this.config.apiKey ||
      (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ||
      "";

    if (!apiKey) {
      throw new Error(`[native] no API key for ${provider} — set it in config or ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}`);
    }

    const systemPrompt = opts.context ? `${BASE_SYSTEM_PROMPT}\n\n${opts.context}` : BASE_SYSTEM_PROMPT;
    const session = opts.name ? `native-${opts.name}-${Date.now().toString(36)}` : `native-${Date.now().toString(36)}`;

    const loop = new AgentLoop({
      agent: opts.name || "native",
      session,
      provider,
      apiKey,
      baseUrl: this.config.baseUrl || DEFAULT_BASE[provider],
      model,
      cwd: opts.cwd,
      systemPrompt,
      bus: this.config.bus,
      maxSteps: this.config.maxSteps,
    });

    console.log(`[native] session ready — ${opts.name || "native"} on ${provider}/${model} (self-hosted loop, no SDK)`);
    return new NativeSession(loop);
  }
}
