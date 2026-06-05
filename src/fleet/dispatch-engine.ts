/**
 * DispatchEngine — turns the gateway's telemetry stream into routing decisions.
 *
 * Subscribes to ThrongTrace events on the fleet bus and maintains:
 *   · a per-agent cost ledger (budget enforcement)
 *   · a live file-ownership map (protocol-level merge-conflict prevention)
 *   · per-agent capability stats (tool counts, error rate, success rate)
 *
 * Exposes decisions the dispatcher consults before assigning work:
 *   · checkWrite(agent, file)  — is another throng actively editing this file?
 *   · suggestTier(task)        — small/mid/large for a task
 *   · isOverBudget(agent)      — has this throng burned its budget?
 *
 * Pure logic over events — fully testable without any live API.
 */

import type { FleetEventBus } from "./manager.js";
import type { FleetEvent } from "./types.js";
import { type ModelTier } from "../gateway/models.js";

export interface DispatchEngineOptions {
  /** Per-agent USD budget; 0 = unlimited. */
  budgetUsdPerAgent?: number;
  /** How long a file stays "owned" after the last touch (ms). */
  lockTtlMs?: number;
}

interface AgentStats {
  toolCalls: number;
  toolResults: number;
  errors: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  lastActive: number;
}

interface FileLock {
  owner: string;
  write: boolean;
  at: number;
}

// Tool names that mutate files (best-effort across providers/runtimes)
const WRITE_TOOLS = new Set([
  "write_file", "create_file", "edit_file", "apply_patch",
  "str_replace_based_edit_tool", "str_replace_editor", "Edit", "Write", "MultiEdit",
]);

function extractFilePath(toolName: string, input: Record<string, unknown>): string | undefined {
  const p = input.path || input.file_path || input.filePath || input.filename;
  if (typeof p === "string") return p;
  return undefined;
}

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export class DispatchEngine {
  private stats = new Map<string, AgentStats>();
  private locks = new Map<string, FileLock>();   // file path → lock
  private opts: Required<DispatchEngineOptions>;
  private conflictCount = 0;

  constructor(bus: FleetEventBus, opts: DispatchEngineOptions = {}) {
    this.opts = {
      budgetUsdPerAgent: opts.budgetUsdPerAgent ?? 0,
      lockTtlMs: opts.lockTtlMs ?? 5 * 60 * 1000,
    };
    bus.onEvent((e) => this.onEvent(e));
  }

  private statsFor(agent: string): AgentStats {
    let s = this.stats.get(agent);
    if (!s) {
      s = { toolCalls: 0, toolResults: 0, errors: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, lastActive: 0 };
      this.stats.set(agent, s);
    }
    return s;
  }

  private onEvent(e: FleetEvent): void {
    const agent = e.agentName;
    if (!agent || agent === "unknown") return;
    const payload = e.payload as Record<string, unknown> | undefined;

    switch (e.type) {
      case "tool_call": {
        const s = this.statsFor(agent);
        s.toolCalls++;
        s.lastActive = Date.now();
        const tool = payload?.tool as { name: string; input: Record<string, unknown> } | undefined;
        if (tool) {
          const file = extractFilePath(tool.name, tool.input || {});
          if (file) this.recordFileTouch(agent, file, isWriteTool(tool.name));
        }
        break;
      }
      case "tool_result": {
        const s = this.statsFor(agent);
        s.toolResults++;
        const result = payload?.result as { ok: boolean } | undefined;
        if (result && result.ok === false) s.errors++;
        break;
      }
      case "usage": {
        const s = this.statsFor(agent);
        const u = payload?.usage as { costUsd: number; inputTokens: number; outputTokens: number } | undefined;
        if (u) {
          s.costUsd += u.costUsd || 0;
          s.inputTokens += u.inputTokens || 0;
          s.outputTokens += u.outputTokens || 0;
        }
        break;
      }
      case "error": {
        this.statsFor(agent).errors++;
        break;
      }
    }
  }

  // ─── File ownership / conflict prevention ──────────────────────────────────

  private recordFileTouch(agent: string, file: string, write: boolean): void {
    this.pruneLocks();
    const existing = this.locks.get(file);
    if (existing && existing.owner !== agent && (existing.write || write)) {
      this.conflictCount++;
      console.warn(`[dispatch] ⚠️ file conflict: ${agent} touched ${file} owned by ${existing.owner}`);
    }
    // Last writer/toucher takes ownership
    this.locks.set(file, { owner: agent, write: write || (existing?.write ?? false), at: Date.now() });
  }

  private pruneLocks(): void {
    const now = Date.now();
    for (const [file, lock] of this.locks) {
      if (now - lock.at > this.opts.lockTtlMs) this.locks.delete(file);
    }
  }

  /** Would `agent` writing `file` collide with another active owner? */
  checkWrite(agent: string, file: string): { allowed: boolean; owner?: string } {
    this.pruneLocks();
    const lock = this.locks.get(file);
    if (lock && lock.owner !== agent && lock.write) {
      return { allowed: false, owner: lock.owner };
    }
    return { allowed: true };
  }

  getFileOwner(file: string): string | undefined {
    this.pruneLocks();
    return this.locks.get(file)?.owner;
  }

  // ─── Budget ────────────────────────────────────────────────────────────────

  getCost(agent: string): number {
    return this.stats.get(agent)?.costUsd ?? 0;
  }

  getTotalCost(): number {
    let total = 0;
    for (const s of this.stats.values()) total += s.costUsd;
    return total;
  }

  isOverBudget(agent: string): boolean {
    if (this.opts.budgetUsdPerAgent <= 0) return false;
    return this.getCost(agent) >= this.opts.budgetUsdPerAgent;
  }

  // ─── Tier policy ─────────────────────────────────────────────────────────────

  /** Heuristic tier suggestion from task text. Dispatch may override. */
  suggestTier(task: string): ModelTier {
    const t = task.toLowerCase();
    const large = /\b(refactor|architect|redesign|design|migrat|security|concurren|race condition|debug.*complex|root cause|investigate)\b/;
    const small = /\b(rename|typo|format|lint|comment|docstring|bump|whitespace|import|trivial|one[- ]liner)\b/;
    if (large.test(t)) return "large";
    if (small.test(t)) return "small";
    return "mid";
  }

  // ─── Reporting ───────────────────────────────────────────────────────────────

  getStats(agent: string): AgentStats & { successRate: number } {
    const s = this.statsFor(agent);
    const successRate = s.toolResults > 0 ? (s.toolResults - s.errors) / s.toolResults : 1;
    return { ...s, successRate };
  }

  summary(): string {
    const lines: string[] = [];
    lines.push(`Total cost: $${this.getTotalCost().toFixed(4)} · conflicts seen: ${this.conflictCount}`);
    for (const [agent, s] of this.stats) {
      const sr = s.toolResults > 0 ? Math.round(((s.toolResults - s.errors) / s.toolResults) * 100) : 100;
      const budget = this.isOverBudget(agent) ? " ⛔OVER-BUDGET" : "";
      lines.push(`  ${agent}: $${s.costUsd.toFixed(4)} · ${s.toolCalls} tools · ${sr}% ok${budget}`);
    }
    this.pruneLocks();
    if (this.locks.size) {
      lines.push("Active file locks:");
      for (const [file, lock] of this.locks) {
        lines.push(`  ${file} ← ${lock.owner}${lock.write ? " (write)" : ""}`);
      }
    }
    return lines.join("\n");
  }
}
