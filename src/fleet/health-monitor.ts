import type { FleetEventBus } from "./manager.js";
import type { AgentState } from "./types.js";
import type { FleetTimeouts } from "../config.js";
import { DEFAULT_TIMEOUTS } from "../config.js";
import { getSessionsDir } from "./state.js";
import { appendFileSync } from "fs";
import { join } from "path";

export interface HealthCheckAgent {
  state: AgentState;
  session: { close(): void } | null;
  sessionId: string;
  processing: boolean;
}

export class HealthMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private bus: FleetEventBus;
  private getAgents: () => Map<string, HealthCheckAgent>;
  private persistState: () => void;
  readonly timeouts: FleetTimeouts;

  constructor(
    bus: FleetEventBus,
    getAgents: () => Map<string, HealthCheckAgent>,
    persistState: () => void,
    timeouts?: FleetTimeouts,
  ) {
    this.bus = bus;
    this.getAgents = getAgents;
    this.persistState = persistState;
    this.timeouts = timeouts || DEFAULT_TIMEOUTS;
  }

  start(): void {
    this.interval = setInterval(() => this.check(), this.timeouts.healthCheckIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  check(): void {
    const now = Date.now();
    let stateChanged = false;
    const agents = this.getAgents();

    for (const [name, live] of agents) {
      // Stuck "working" — only intervene if NOT actively processing
      // If processing is true, the SDK call is still in flight; let the send timeout handle it
      if (live.state.status === "working" && !live.processing && live.state.lastActivity) {
        const elapsed = now - new Date(live.state.lastActivity).getTime();
        if (elapsed > this.timeouts.stuckWorkingGraceMs) {
          console.log(`[fleet] ${name}: unresponsive for ${Math.round(elapsed / 60_000)}min (not processing) — auto-recovering`);
          if (live.session) {
            try { live.session.close(); } catch {}
            live.session = null;
          }
          live.state.status = "sleeping";
          live.state.inferred = `auto-recovered — was unresponsive for ${Math.round(elapsed / 60_000)}min`;
          this.bus.publish("status_change", name, live.sessionId, { status: "sleeping" });
          this.logToSession(name, live.sessionId, {
            type: "health_check",
            status: "auto_recovered",
            elapsed_ms: elapsed,
          });
          stateChanged = true;
        }
      }

      // Dead/error agents — recover to sleeping (but don't touch processing flag)
      if ((live.state.status === "dead" || live.state.status === "error") && !live.processing) {
        console.log(`[fleet] ${name}: auto-recovering from ${live.state.status} → sleeping`);
        if (live.session) {
          try { live.session.close(); } catch {}
          live.session = null;
        }
        live.state.status = "sleeping";
        live.state.inferred = `auto-recovered from ${live.state.status} — will reconnect on next message`;
        this.bus.publish("status_change", name, live.sessionId, { status: "sleeping" });
        stateChanged = true;
      }

      // Idle "waiting" with open session — close session to free resources
      if (live.state.status === "waiting" && live.session && live.state.lastActivity) {
        const idleMs = now - new Date(live.state.lastActivity).getTime();
        if (idleMs > this.timeouts.sessionMaxAgeMs) {
          try { live.session.close(); } catch {}
          live.session = null;
          live.state.status = "sleeping";
          live.state.inferred = `sleeping — idle for ${Math.round(idleMs / 60_000)}min, will reconnect on next message`;
          this.bus.publish("status_change", name, live.sessionId, { status: "sleeping" });
          stateChanged = true;
          console.log(`[fleet] ${name}: waiting → sleeping after ${Math.round(idleMs / 60_000)}min`);
        }
      }
    }
    if (stateChanged) this.persistState();
  }

  private logToSession(agentName: string, sessionId: string, entry: Record<string, unknown>): void {
    const dir = getSessionsDir(agentName);
    const file = join(dir, `${sessionId}.jsonl`);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
}
