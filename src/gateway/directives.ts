/**
 * Per-agent model directives.
 *
 * Dispatch sets a desired model tier for an agent's next task; the gateway
 * reads it and rewrites the upstream request's `model` field. This is the
 * mechanism behind per-task model switching — a throng is no longer pinned
 * to one model for its whole life.
 *
 * Shared singleton so the gateway (server layer) and dispatch (fleet layer)
 * see the same store without threading it through every constructor.
 */

import type { ModelTier } from "./models.js";

export interface AgentDirective {
  tier?: ModelTier;
  /** If true, the directive applies to one request then auto-clears. */
  oneShot?: boolean;
  setAt: string;
}

class DirectiveStore {
  private directives = new Map<string, AgentDirective>();

  /** Set the active tier for an agent. oneShot clears after the next consume(). */
  setTier(agent: string, tier: ModelTier, oneShot = false): void {
    this.directives.set(agent, { tier, oneShot, setAt: new Date().toISOString() });
  }

  /** Read the active tier without consuming it. */
  getTier(agent: string): ModelTier | undefined {
    return this.directives.get(agent)?.tier;
  }

  /**
   * Read the tier and, if it was one-shot, clear it. Called by the gateway
   * when it actually applies the directive to a request.
   */
  consumeTier(agent: string): ModelTier | undefined {
    const d = this.directives.get(agent);
    if (!d) return undefined;
    if (d.oneShot) this.directives.delete(agent);
    return d.tier;
  }

  clear(agent: string): void {
    this.directives.delete(agent);
  }

  clearAll(): void {
    this.directives.clear();
  }

  snapshot(): Record<string, AgentDirective> {
    return Object.fromEntries(this.directives);
  }
}

export const directiveStore = new DirectiveStore();
