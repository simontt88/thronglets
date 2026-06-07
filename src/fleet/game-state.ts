/**
 * GameEngine — turns real telemetry into game state.
 *
 * The roadmap wanted creature mood to "reflect real performance ... part of the
 * reward loop" but it was impossible without real signals. The gateway provides
 * them, so XP / level / stats / mood are now driven by what throngs actually do:
 * tools run, tests passed, tokens burned, errors hit.
 *
 * Pure logic over fleet-bus events — fully testable without any live API.
 */

import type { FleetEventBus } from "./manager.js";
import type { FleetEvent } from "./types.js";

export type Mood = "idle" | "thinking" | "working" | "stuck" | "triumphant" | "exhausted";

export interface GameStats {
  xp: number;
  level: number;
  toolCalls: number;
  testsPassed: number;
  errors: number;
  avgLatencyMs: number;
  totalTokens: number;
  costUsd: number;
  specialty: string;       // most-used tool category
  mood: Mood;
}

interface AgentGame {
  xp: number;
  toolCalls: number;
  testsPassed: number;
  errors: number;
  latencySum: number;
  latencyCount: number;
  totalTokens: number;
  costUsd: number;
  categoryCounts: Record<string, number>;
  recent: Array<{ t: number; kind: string; ok?: boolean; tokens?: number; test?: "pass" | "fail" }>;
}

// XP rewards
const XP_TOOL_CALL = 1;
const XP_TOOL_OK = 3;
const XP_TEST_PASS = 50;

const MOOD_WINDOW_MS = 30_000;
const EXHAUSTION_TOKENS = 20_000;   // tokens within window → exhausted

// Tool → category (for specialty)
function toolCategory(name: string): string {
  const n = name.toLowerCase();
  if (/read|cat|open|view/.test(n)) return "reading";
  if (/edit|write|create|patch|replace|multiedit/.test(n)) return "editing";
  if (/bash|exec|shell|run|command|terminal/.test(n)) return "running";
  if (/grep|glob|search|find|list/.test(n)) return "searching";
  return "other";
}

/** Detect a test outcome from a bash-style tool result preview. */
function detectTest(preview: string): "pass" | "fail" | undefined {
  const p = preview.toLowerCase();
  if (!/test|spec|suite|pytest|vitest|jest|assert/.test(p)) return undefined;
  // Non-zero failure counts or hard errors → fail ("0 failed" must NOT match)
  if (/[1-9]\d*\s*(failed|failing|failures|errors)/.test(p) || /\b(traceback|exception|not ok)\b|✗|❌/.test(p)) return "fail";
  // Passing indicators (incl. "0 failed")
  if (/passed|✓|✔|0\s*(failed|failures)|all tests pass|success/.test(p)) return "pass";
  return undefined;
}

/** Cumulative XP needed to reach a level (triangular growth). */
export function levelForXp(xp: number): number {
  let level = 1;
  let need = 100;
  let acc = 0;
  while (xp >= acc + need) {
    acc += need;
    level++;
    need = 100 * level;   // 100, 200, 300, ... per level
  }
  return level;
}

export class GameEngine {
  private games = new Map<string, AgentGame>();

  constructor(bus: FleetEventBus) {
    bus.onEvent((e) => this.onEvent(e));
  }

  private gameFor(agent: string): AgentGame {
    let g = this.games.get(agent);
    if (!g) {
      g = {
        xp: 0, toolCalls: 0, testsPassed: 0, errors: 0,
        latencySum: 0, latencyCount: 0, totalTokens: 0, costUsd: 0,
        categoryCounts: {}, recent: [],
      };
      this.games.set(agent, g);
    }
    return g;
  }

  private onEvent(e: FleetEvent): void {
    const agent = e.agentName;
    if (!agent || agent === "unknown") return;
    const now = Date.now();
    const payload = e.payload as Record<string, unknown> | undefined;
    const g = this.gameFor(agent);

    switch (e.type) {
      case "tool_call": {
        g.toolCalls++;
        g.xp += XP_TOOL_CALL;
        const tool = payload?.tool as { name: string } | undefined;
        if (tool) {
          const cat = toolCategory(tool.name);
          g.categoryCounts[cat] = (g.categoryCounts[cat] || 0) + 1;
        }
        g.recent.push({ t: now, kind: "tool_call" });
        break;
      }
      case "tool_result": {
        const result = payload?.result as { ok: boolean; preview: string } | undefined;
        if (result) {
          if (result.ok) g.xp += XP_TOOL_OK;
          else g.errors++;
          const test = detectTest(result.preview || "");
          if (test === "pass") { g.testsPassed++; g.xp += XP_TEST_PASS; }
          g.recent.push({ t: now, kind: "tool_result", ok: result.ok, test });
        }
        break;
      }
      case "usage": {
        const u = payload?.usage as { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number } | undefined;
        if (u) {
          const tokens = (u.inputTokens || 0) + (u.outputTokens || 0);
          g.totalTokens += tokens;
          g.costUsd += u.costUsd || 0;
          g.latencySum += u.latencyMs || 0;
          g.latencyCount++;
          g.recent.push({ t: now, kind: "usage", tokens });
        }
        break;
      }
      case "error": {
        g.errors++;
        g.recent.push({ t: now, kind: "error", ok: false });
        break;
      }
    }

    // Trim recent window
    g.recent = g.recent.filter((r) => now - r.t <= MOOD_WINDOW_MS);
  }

  private computeMood(g: AgentGame): Mood {
    const now = Date.now();
    const recent = g.recent.filter((r) => now - r.t <= MOOD_WINDOW_MS);
    if (recent.length === 0) return "idle";

    // Triumphant: a test passed very recently
    if (recent.some((r) => r.test === "pass")) return "triumphant";

    // Stuck: 2+ errors/failures in window
    const fails = recent.filter((r) => r.ok === false || r.test === "fail").length;
    if (fails >= 2) return "stuck";

    // Exhausted: heavy token burn in window
    const tokens = recent.reduce((sum, r) => sum + (r.tokens || 0), 0);
    if (tokens >= EXHAUSTION_TOKENS) return "exhausted";

    // Working: tools are flowing
    if (recent.some((r) => r.kind === "tool_call")) return "working";

    // Thinking: model calls but no tools yet
    if (recent.some((r) => r.kind === "usage")) return "thinking";

    return "idle";
  }

  private specialty(g: AgentGame): string {
    let best = "generalist";
    let max = 0;
    for (const [cat, n] of Object.entries(g.categoryCounts)) {
      if (n > max) { max = n; best = cat; }
    }
    return best;
  }

  getStats(agent: string): GameStats {
    const g = this.gameFor(agent);
    return {
      xp: g.xp,
      level: levelForXp(g.xp),
      toolCalls: g.toolCalls,
      testsPassed: g.testsPassed,
      errors: g.errors,
      avgLatencyMs: g.latencyCount ? Math.round(g.latencySum / g.latencyCount) : 0,
      totalTokens: g.totalTokens,
      costUsd: g.costUsd,
      specialty: this.specialty(g),
      mood: this.computeMood(g),
    };
  }

  getAll(): Record<string, GameStats> {
    const out: Record<string, GameStats> = {};
    for (const agent of this.games.keys()) out[agent] = this.getStats(agent);
    return out;
  }
}
