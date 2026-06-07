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

// USD per 1M tokens. Approximate, prefix-matched, and meant to be in the right
// ballpark for budgeting — not billing-exact. More-specific families are listed
// before their base so prefix matching resolves the cheaper variant first.
const PRICES: Record<string, Price> = {
  // OpenAI — GPT-4o
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
  "gpt-4o": { input: 2.5, output: 10, cached: 1.25 },
  // OpenAI — GPT-4.1
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cached: 0.025 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cached: 0.1 },
  "gpt-4.1": { input: 2.0, output: 8, cached: 0.5 },
  // OpenAI — GPT-5 family (gpt-5.1 / 5.2 resolve to the base via prefix)
  "gpt-5-nano": { input: 0.05, output: 0.4, cached: 0.005 },
  "gpt-5-mini": { input: 0.25, output: 2, cached: 0.025 },
  "gpt-5": { input: 1.25, output: 10, cached: 0.125 },
  // OpenAI — o-series reasoning
  "o4-mini": { input: 1.1, output: 4.4, cached: 0.275 },
  "o3-mini": { input: 1.1, output: 4.4, cached: 0.55 },
  "o3": { input: 2.0, output: 8, cached: 0.5 },
  "o1-mini": { input: 1.1, output: 4.4, cached: 0.55 },
  "o1": { input: 15, output: 60, cached: 7.5 },
  // Anthropic
  "claude-haiku-4-5": { input: 1.0, output: 5, cached: 0.1 },
  "claude-sonnet-4-6": { input: 3.0, output: 15, cached: 0.3 },
  "claude-opus-4-8": { input: 15, output: 75, cached: 1.5 },
};

// Longest keys first so a specific family (e.g. gpt-5-mini) wins over its base
// (gpt-5) regardless of object insertion order.
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

function priceFor(model: string): Price | undefined {
  if (PRICES[model]) return PRICES[model];
  // Prefix match (model ids often carry date suffixes, e.g. gpt-4o-2024-08-06)
  for (const key of PRICE_KEYS) {
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
