/**
 * Token-gateway governance — virtual keys, budgets, rate limits.
 *
 * Bifrost-inspired: agents authenticate to the gateway with a *virtual key*
 * (`vk-<agent>`) and never hold a real provider key. Each virtual key carries a
 * policy — which providers it may reach, a spend/token budget over a window, and
 * an optional request-rate limit. The gateway holds the real upstream keys and
 * meters every call against the policy.
 *
 * Usage is accrued from the `usage` telemetry the proxy already emits (one source
 * of truth for cost), persisted to a ledger so budgets survive restarts. Budget
 * checks are pre-flight and soft: the in-flight request is allowed to tip a VK
 * over its limit; the *next* one is blocked or downgraded per `onExceed`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { GLOBAL_CONFIG_DIR } from "../config.js";
import type { ApiProvider } from "./models.js";

export type BudgetWindow = "daily" | "monthly" | "total";
export type OnExceed = "block" | "downgrade";

export interface Budget {
  /** Spend cap in USD for the window. */
  usd?: number;
  /** Total-token cap (input+output) for the window. */
  tokens?: number;
  window: BudgetWindow;
}

export interface VirtualKeyPolicy {
  /** Providers this VK may reach. Empty/undefined = any configured provider. */
  providers?: ApiProvider[];
  budget?: Budget;
  /** What to do once the budget is spent. Default: block. */
  onExceed: OnExceed;
  /** Requests-per-minute cap (0/undefined = unlimited). */
  rpm?: number;
}

export interface ProviderPool {
  /** One or more upstream keys — load-balanced and failed over in order. */
  keys: string[];
}

export interface GatewayPolicy {
  enabled: boolean;
  providers: Partial<Record<ApiProvider, ProviderPool>>;
  /** Keyed by agent name; "*" is the default policy for any unlisted agent. */
  virtualKeys: Record<string, VirtualKeyPolicy>;
}

const DEFAULT_POLICY: VirtualKeyPolicy = { onExceed: "block" };

// ─── Ledger ───────────────────────────────────────────────────────────────────

interface WindowUsage {
  /** Calendar key the window is anchored to ("2026-06-07", "2026-06", "all"). */
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface LedgerEntry {
  daily: WindowUsage;
  monthly: WindowUsage;
  total: WindowUsage;
  lastSeen: number;
}

type Ledger = Record<string, LedgerEntry>;

function windowKey(window: BudgetWindow, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  if (window === "daily") return `${y}-${m}-${d}`;
  if (window === "monthly") return `${y}-${m}`;
  return "all";
}

function freshWindow(window: BudgetWindow, now: Date): WindowUsage {
  return { key: windowKey(window, now), requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

function freshEntry(now: Date): LedgerEntry {
  return {
    daily: freshWindow("daily", now),
    monthly: freshWindow("monthly", now),
    total: freshWindow("total", now),
    lastSeen: now.getTime(),
  };
}

/** Roll a window over to the current period if the calendar key changed. */
function rolled(usage: WindowUsage, window: BudgetWindow, now: Date): WindowUsage {
  const key = windowKey(window, now);
  return usage.key === key ? usage : freshWindow(window, now);
}

// ─── Usage shape (subset of the proxy's UsageInfo) ──────────────────────────────

export interface AccruedUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Authorization {
  allow: boolean;
  /** When set, the request should be downgraded to this tier before forwarding. */
  downgradeTier?: "small";
  /** Human-readable reason when blocked. */
  reason?: string;
  /** HTTP status to return when blocked (402 over-budget, 429 rate-limited). */
  status?: number;
}

const LEDGER_PATH = join(GLOBAL_CONFIG_DIR, "fleet", "gateway-ledger.json");

export class GovernanceManager {
  private policy: GatewayPolicy;
  private ledger: Ledger;
  private rrCursor = new Map<ApiProvider, number>();
  private rpmHits = new Map<string, number[]>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private ledgerPath: string;

  constructor(policy: GatewayPolicy, ledgerPath: string = LEDGER_PATH) {
    this.policy = policy;
    this.ledgerPath = ledgerPath;
    this.ledger = this.loadLedger();
  }

  get enabled(): boolean {
    return this.policy.enabled;
  }

  // ── Virtual-key helpers ──────────────────────────────────────────────────────

  static vkFor(agent: string): string {
    return `vk-${agent}`;
  }

  /** Resolve a consumer identity from a `vk-…` token (or pass an agent through). */
  static agentFromVk(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const t = token.replace(/^Bearer\s+/i, "").trim();
    return t.startsWith("vk-") ? t.slice(3) : undefined;
  }

  policyFor(agent: string): VirtualKeyPolicy {
    return this.policy.virtualKeys[agent] || this.policy.virtualKeys["*"] || DEFAULT_POLICY;
  }

  hasProvider(provider: ApiProvider): boolean {
    return !!this.policy.providers[provider]?.keys.length;
  }

  /** Upstream keys for a provider, ordered for load-balance + failover. */
  providerKeys(provider: ApiProvider): string[] {
    const pool = this.policy.providers[provider];
    if (!pool || pool.keys.length === 0) return [];
    const start = this.rrCursor.get(provider) ?? 0;
    this.rrCursor.set(provider, (start + 1) % pool.keys.length);
    // Rotate so each call starts at a different key, then falls through the rest.
    return [...pool.keys.slice(start), ...pool.keys.slice(0, start)];
  }

  // ── Authorization (pre-flight) ───────────────────────────────────────────────

  authorize(agent: string, provider: ApiProvider, now: Date = new Date()): Authorization {
    const policy = this.policyFor(agent);

    if (policy.providers && policy.providers.length && !policy.providers.includes(provider)) {
      return { allow: false, status: 403, reason: `virtual key for "${agent}" is not allowed to use ${provider}` };
    }

    // Rate limit (sliding 60s window).
    if (policy.rpm && policy.rpm > 0) {
      const hits = (this.rpmHits.get(agent) || []).filter((t) => now.getTime() - t < 60_000);
      if (hits.length >= policy.rpm) {
        return { allow: false, status: 429, reason: `rate limit: ${policy.rpm} req/min exceeded for "${agent}"` };
      }
    }

    // Budget.
    const budget = policy.budget;
    if (budget) {
      const entry = this.ledger[agent];
      const used = entry ? rolled(entry[budget.window], budget.window, now) : undefined;
      const spentUsd = used?.costUsd ?? 0;
      const spentTokens = (used?.inputTokens ?? 0) + (used?.outputTokens ?? 0);
      const overUsd = budget.usd != null && spentUsd >= budget.usd;
      const overTokens = budget.tokens != null && spentTokens >= budget.tokens;
      if (overUsd || overTokens) {
        const detail = overUsd
          ? `$${spentUsd.toFixed(4)}/$${budget.usd} (${budget.window})`
          : `${spentTokens}/${budget.tokens} tokens (${budget.window})`;
        if (policy.onExceed === "downgrade") {
          return { allow: true, downgradeTier: "small", reason: `over budget ${detail} — downgraded` };
        }
        return { allow: false, status: 402, reason: `budget exhausted for "${agent}": ${detail}` };
      }
    }

    return { allow: true };
  }

  /** Record that a request was admitted (drives the rpm window). */
  noteRequest(agent: string, now: Date = new Date()): void {
    const hits = (this.rpmHits.get(agent) || []).filter((t) => now.getTime() - t < 60_000);
    hits.push(now.getTime());
    this.rpmHits.set(agent, hits);
  }

  // ── Accrual (post-flight, fed by the bus `usage` stream) ─────────────────────

  recordUsage(agent: string, usage: AccruedUsage, now: Date = new Date()): void {
    if (!agent || agent === "unknown") return;
    const entry = this.ledger[agent] || (this.ledger[agent] = freshEntry(now));
    for (const w of ["daily", "monthly", "total"] as const) {
      const win = rolled(entry[w], w, now);
      win.requests += 1;
      win.inputTokens += usage.inputTokens || 0;
      win.outputTokens += usage.outputTokens || 0;
      win.costUsd += usage.costUsd || 0;
      entry[w] = win;
    }
    entry.lastSeen = now.getTime();
    this.scheduleSave();
  }

  // ── Observability ────────────────────────────────────────────────────────────

  stats(now: Date = new Date()): Record<string, unknown> {
    const keys: Record<string, unknown> = {};
    for (const [agent, entry] of Object.entries(this.ledger)) {
      const policy = this.policyFor(agent);
      const budget = policy.budget;
      const win = budget ? rolled(entry[budget.window], budget.window, now) : entry.total;
      const remainingUsd = budget?.usd != null ? Math.max(0, budget.usd - win.costUsd) : null;
      keys[GovernanceManager.vkFor(agent)] = {
        agent,
        onExceed: policy.onExceed,
        rpm: policy.rpm ?? null,
        budget: budget ? { usd: budget.usd ?? null, tokens: budget.tokens ?? null, window: budget.window } : null,
        used: {
          requests: win.requests,
          inputTokens: win.inputTokens,
          outputTokens: win.outputTokens,
          costUsd: Number(win.costUsd.toFixed(6)),
        },
        remainingUsd: remainingUsd != null ? Number(remainingUsd.toFixed(6)) : null,
        lifetimeCostUsd: Number(entry.total.costUsd.toFixed(6)),
      };
    }
    return {
      enabled: this.policy.enabled,
      providers: Object.fromEntries(
        (Object.keys(this.policy.providers) as ApiProvider[]).map((p) => [
          p,
          { keys: this.policy.providers[p]?.keys.length ?? 0 },
        ]),
      ),
      virtualKeys: keys,
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private loadLedger(): Ledger {
    try {
      if (existsSync(this.ledgerPath)) {
        return JSON.parse(readFileSync(this.ledgerPath, "utf-8")) as Ledger;
      }
    } catch (err) {
      console.warn(`[gateway/governance] ledger load failed: ${(err as Error).message}`);
    }
    return {};
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 2000);
    // Don't keep the event loop alive just for a ledger flush.
    if (typeof this.saveTimer === "object" && "unref" in this.saveTimer) this.saveTimer.unref();
  }

  flush(): void {
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      writeFileSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2));
    } catch (err) {
      console.warn(`[gateway/governance] ledger save failed: ${(err as Error).message}`);
    }
  }
}

// ─── Build a policy from config (with a backward-compatible fallback) ───────────

import type { GatewayDef } from "../config.js";

/**
 * Resolve a runtime GatewayPolicy. When the user supplies a `gateway:` block we
 * use it verbatim. Otherwise we synthesize an observe-only policy from the
 * provider keys already present on the agents, so existing configs keep working
 * (metering on, no budgets) the moment the gateway is mounted.
 */
export function buildGatewayPolicy(
  def: GatewayDef | undefined,
  fallbackKeys: { openai?: string; anthropic?: string },
): GatewayPolicy {
  // Provider keys: an explicit pool in the block wins; otherwise fall back to the
  // key already configured on the agents (so `gateway: { enabled: true }` works
  // on its own, and existing configs meter the moment the gateway is mounted).
  const providers: GatewayPolicy["providers"] = {};
  const openai = def?.providers?.openai?.keys.length ? def.providers.openai.keys : (fallbackKeys.openai ? [fallbackKeys.openai] : []);
  const anthropic = def?.providers?.anthropic?.keys.length ? def.providers.anthropic.keys : (fallbackKeys.anthropic ? [fallbackKeys.anthropic] : []);
  if (openai.length) providers.openai = { keys: openai };
  if (anthropic.length) providers.anthropic = { keys: anthropic };

  const hasKeys = !!(providers.openai || providers.anthropic);
  return {
    // Explicit block: honor enabled. No block: observe-only when keys exist.
    enabled: def ? def.enabled && hasKeys : hasKeys,
    providers,
    // Budgets/limits only apply when the user opted in with an explicit block.
    virtualKeys: def?.enabled ? def.virtualKeys || {} : {},
  };
}
