/**
 * ThrongTrace — the unified, machine-readable activity stream.
 *
 * Both Anthropic and OpenAI traffic is normalized into ThrongTrace events,
 * emitted on the fleet bus (for the dashboard) and persisted as JSONL
 * (for replay and metrics). This is the raw material for dispatch + gamification.
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { GLOBAL_CONFIG_DIR } from "../config.js";
import type { ApiProvider } from "./models.js";

export type TraceKind = "tool_call" | "tool_result" | "usage" | "model_switch" | "error";

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
  model: string;
}

export interface ThrongTrace {
  agent: string;
  session: string;
  ts: string;
  kind: TraceKind;
  provider: ApiProvider;
  tool?: { id: string; name: string; input: Record<string, unknown>; summary: string };
  result?: { toolId: string; ok: boolean; preview: string };
  usage?: UsageInfo;
  error?: { type: string; message: string };
}

// ─── Pricing (USD per 1M tokens; rough, override-friendly) ────────────────────

interface Price { input: number; output: number; cached: number }

const PRICES: Record<string, Price> = {
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
  "gpt-4o": { input: 2.5, output: 10, cached: 1.25 },
  "gpt-4.1": { input: 2.0, output: 8, cached: 0.5 },
  // Anthropic
  "claude-haiku-4-5": { input: 1.0, output: 5, cached: 0.1 },
  "claude-sonnet-4-6": { input: 3.0, output: 15, cached: 0.3 },
  "claude-opus-4-8": { input: 15, output: 75, cached: 1.5 },
};

function priceFor(model: string): Price | undefined {
  if (PRICES[model]) return PRICES[model];
  // Prefix match (model ids often carry date suffixes, e.g. gpt-4o-2024-08-06)
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key];
  }
  return undefined;
}

export function computeCost(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const p = priceFor(model);
  if (!p) return 0;
  const billedInput = Math.max(0, inputTokens - cachedTokens);
  return (
    (billedInput * p.input) / 1_000_000 +
    (cachedTokens * p.cached) / 1_000_000 +
    (outputTokens * p.output) / 1_000_000
  );
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const TRACES_ROOT = join(GLOBAL_CONFIG_DIR, "fleet", "traces");

export function traceFilePath(agent: string, session: string): string {
  const safeAgent = agent.replace(/[^\w.-]/g, "_");
  const safeSession = (session || "default").replace(/[^\w.-]/g, "_");
  return join(TRACES_ROOT, safeAgent, `${safeSession}.jsonl`);
}

/** Append a trace event to its per-agent/session JSONL file. Best-effort. */
export function persistTrace(trace: ThrongTrace): void {
  try {
    const file = traceFilePath(trace.agent, trace.session);
    const dir = join(TRACES_ROOT, trace.agent.replace(/[^\w.-]/g, "_"));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(trace) + "\n");
  } catch (err) {
    console.warn(`[trace] persist failed: ${(err as Error).message}`);
  }
}
