import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentDef, BridgeConfig, RuntimeType } from "../config.js";
import type { Runtime } from "../runtimes/interface.js";
import type { AgentSession } from "../runtimes/interface.js";
import { FleetEventBus } from "./event-bus.js";
import { loadFleetState, saveFleetState, getSessionsDir } from "./state.js";
import type { AgentState, AgentStatus, FleetState } from "./types.js";

export interface WorkspaceEntry {
  alias: string;
  path: string;
}

interface LiveAgent {
  state: AgentState;
  runtime: Runtime;
  session: AgentSession | null;
  sessionId: string;
}

export interface FleetManagerConfig {
  workspaces: WorkspaceEntry[];
  createRuntime: (agent: AgentDef) => Runtime;
  ensureRulesSync: (agent: AgentDef) => Promise<void>;
  getAgentDef: (runtime: RuntimeType, model?: string) => AgentDef;
}

export class FleetManager {
  private agents = new Map<string, LiveAgent>();
  private bus: FleetEventBus;
  private config: FleetManagerConfig;
  private processing = new Set<string>();

  constructor(bus: FleetEventBus, config: FleetManagerConfig) {
    this.bus = bus;
    this.config = config;
  }

  get eventBus(): FleetEventBus {
    return this.bus;
  }

  private generateSessionId(): string {
    const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const rand = Math.random().toString(36).slice(2, 8);
    return `s-${date}-${rand}`;
  }

  private resolveWorkspace(alias: string): string | null {
    const ws = this.config.workspaces.find((w) => w.alias === alias);
    return ws?.path || null;
  }

  private logToSession(agentName: string, sessionId: string, entry: Record<string, unknown>): void {
    const dir = getSessionsDir(agentName);
    const file = join(dir, `${sessionId}.jsonl`);
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  private persistState(): void {
    const state: FleetState = {
      agents: {},
      version: 1,
      lastUpdated: new Date().toISOString(),
    };
    for (const [name, live] of this.agents) {
      state.agents[name] = { ...live.state };
    }
    saveFleetState(state);
  }

  async spawn(name: string, runtime: RuntimeType, workspaceAlias: string, model?: string): Promise<string> {
    if (this.agents.has(name)) {
      return `Agent "${name}" already exists. Use /kill first.`;
    }

    const workspacePath = this.resolveWorkspace(workspaceAlias);
    if (!workspacePath) {
      const available = this.config.workspaces.map((w) => w.alias).join(", ");
      return `Unknown workspace "${workspaceAlias}". Available: ${available}`;
    }

    const agentDef = this.config.getAgentDef(runtime, model);
    if (!agentDef.apiKey && runtime !== "codex") {
      return `No API key configured for runtime "${runtime}".`;
    }

    await this.config.ensureRulesSync(agentDef);

    const runtimeInstance = this.config.createRuntime(agentDef);
    const sessionId = this.generateSessionId();

    const agentState: AgentState = {
      name,
      runtime,
      model: agentDef.model,
      workspace: workspaceAlias,
      workspacePath,
      status: "idle",
      currentSessionId: sessionId,
      spawnedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      messageCount: 0,
    };

    this.agents.set(name, {
      state: agentState,
      runtime: runtimeInstance,
      session: null,
      sessionId,
    });

    this.bus.publish("agent_spawned", name, sessionId, { runtime, workspace: workspaceAlias, model: agentDef.model });
    this.persistState();

    return `Agent "${name}" spawned (${runtime} · ${agentDef.model} · ${workspaceAlias})`;
  }

  async kill(name: string): Promise<string> {
    const live = this.agents.get(name);
    if (!live) {
      return `Agent "${name}" not found.`;
    }

    if (live.session) {
      try { live.session.close(); } catch {}
    }

    this.bus.publish("agent_killed", name, live.sessionId);
    this.agents.delete(name);
    this.persistState();

    return `Agent "${name}" killed. Sessions preserved on disk.`;
  }

  async send(name: string, text: string): Promise<string> {
    const live = this.agents.get(name);
    if (!live) {
      return `Agent "${name}" not found. Use /new to spawn.`;
    }

    if (this.processing.has(name)) {
      return `Agent "${name}" is still processing a previous message...`;
    }

    this.processing.add(name);
    live.state.status = "working";
    live.state.lastActivity = new Date().toISOString();
    this.bus.publish("status_change", name, live.sessionId, { status: "working" });
    this.bus.publish("user_message", name, live.sessionId, { text });
    this.logToSession(name, live.sessionId, { type: "user_message", text });

    try {
      if (!live.session) {
        live.session = await live.runtime.createSession({
          cwd: live.state.workspacePath,
          model: live.state.model,
          context: "",
          name: `fleet-${name}-${live.sessionId}`,
        });
        this.bus.publish("session_started", name, live.sessionId);
      }

      const reply = await live.session.send(text);

      live.state.messageCount++;
      live.state.status = "idle";
      live.state.lastActivity = new Date().toISOString();
      this.bus.publish("agent_message", name, live.sessionId, { text: reply });
      this.bus.publish("status_change", name, live.sessionId, { status: "idle" });
      this.logToSession(name, live.sessionId, { type: "agent_message", text: reply });
      this.persistState();

      return reply;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      live.state.status = "error";
      this.bus.publish("error", name, live.sessionId, { error: errMsg });
      this.logToSession(name, live.sessionId, { type: "error", error: errMsg });
      this.persistState();

      // Reset session on error so next message creates fresh
      if (live.session) {
        try { live.session.close(); } catch {}
        live.session = null;
      }

      throw err;
    } finally {
      this.processing.delete(name);
    }
  }

  async clear(name: string): Promise<string> {
    const live = this.agents.get(name);
    if (!live) {
      return `Agent "${name}" not found.`;
    }

    if (live.session) {
      try { live.session.close(); } catch {}
      live.session = null;
    }

    const oldSessionId = live.sessionId;
    const newSessionId = this.generateSessionId();

    live.sessionId = newSessionId;
    live.state.currentSessionId = newSessionId;
    live.state.status = "idle";
    live.state.messageCount = 0;
    live.state.lastActivity = new Date().toISOString();

    this.bus.publish("session_cleared", name, oldSessionId, { newSessionId });
    this.persistState();

    return `Session cleared for "${name}". New session: ${newSessionId}`;
  }

  isProcessing(name: string): boolean {
    return this.processing.has(name);
  }

  getStatus(): { agents: AgentState[]; total: number; working: number; idle: number } {
    const agents = Array.from(this.agents.values()).map((a) => a.state);
    return {
      agents,
      total: agents.length,
      working: agents.filter((a) => a.status === "working").length,
      idle: agents.filter((a) => a.status === "idle").length,
    };
  }

  getAgent(name: string): AgentState | null {
    return this.agents.get(name)?.state || null;
  }

  listAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  async restore(): Promise<void> {
    const saved = loadFleetState();
    if (!Object.keys(saved.agents).length) return;

    console.log(`[fleet] restoring ${Object.keys(saved.agents).length} agents from state...`);
    for (const [name, agentState] of Object.entries(saved.agents)) {
      const workspacePath = this.resolveWorkspace(agentState.workspace);
      if (!workspacePath) {
        console.warn(`[fleet] skipping "${name}" — workspace "${agentState.workspace}" not found`);
        continue;
      }

      const agentDef = this.config.getAgentDef(agentState.runtime as RuntimeType);
      const runtimeInstance = this.config.createRuntime(agentDef);

      this.agents.set(name, {
        state: { ...agentState, status: "idle" },
        runtime: runtimeInstance,
        session: null,
        sessionId: agentState.currentSessionId,
      });

      console.log(`[fleet] restored "${name}" (${agentState.runtime} · ${agentState.workspace})`);
    }
  }
}
