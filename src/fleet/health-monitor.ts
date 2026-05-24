import type { FleetEventBus } from "./manager.js";
import type { AgentState } from "./types.js";
import { getSessionsDir } from "./state.js";
import { appendFileSync } from "fs";
import { join } from "path";

const SEND_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;

export { SEND_TIMEOUT_MS, SESSION_MAX_AGE_MS };

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

  constructor(
    bus: FleetEventBus,
    getAgents: () => Map<string, HealthCheckAgent>,
    persistState: () => void,
  ) {
    this.bus = bus;
    this.getAgents = getAgents;
    this.persistState = persistState;
  }

  start(): void {
    this.interval = setInterval(() => this.check(), HEALTH_CHECK_INTERVAL_MS);
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
      if (live.state.status === "working" && live.state.lastActivity) {
        const elapsed = now - new Date(live.state.lastActivity).getTime();
        if (elapsed > SEND_TIMEOUT_MS + 30_000) {
          console.log(`[fleet] ${name}: unresponsive for ${Math.round(elapsed / 60_000)}min — auto-recovering`);
          live.processing = false;
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

      if (live.state.status === "dead" || live.state.status === "error") {
        console.log(`[fleet] ${name}: auto-recovering from ${live.state.status} → sleeping`);
        if (live.session) {
          try { live.session.close(); } catch {}
          live.session = null;
        }
        live.processing = false;
        live.state.status = "sleeping";
        live.state.inferred = `auto-recovered from ${live.state.status} — will reconnect on next message`;
        this.bus.publish("status_change", name, live.sessionId, { status: "sleeping" });
        stateChanged = true;
      }

      if (live.state.status === "waiting" && live.session && live.state.lastActivity) {
        const idleMs = now - new Date(live.state.lastActivity).getTime();
        if (idleMs > SESSION_MAX_AGE_MS) {
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
