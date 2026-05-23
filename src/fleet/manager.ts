import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentDef, BridgeConfig, RuntimeType } from "../config.js";
import type { Runtime } from "../runtimes/interface.js";
import type { AgentSession } from "../runtimes/interface.js";
import { FleetEventBus } from "./event-bus.js";
import { loadFleetState, saveFleetState, getSessionsDir, addWorkspace as addWorkspaceToState } from "./state.js";
import { getToolInstructions } from "./tool-instructions.js";
import { generateUniqueName } from "./naming.js";
import type { AgentState, AgentStatus, FleetState, QueuedMessage, MessageSender } from "./types.js";

export interface WorkspaceEntry {
  alias: string;
  path: string;
}

interface LiveAgent {
  state: AgentState;
  runtime: Runtime;
  session: AgentSession | null;
  sessionId: string;
  messageQueue: QueuedMessage[];
  processing: boolean;
}

export interface FleetManagerConfig {
  workspaces: WorkspaceEntry[];
  createRuntime: (agent: AgentDef) => Runtime;
  ensureRulesSync: (agent: AgentDef) => Promise<void>;
  getAgentDef: (runtime: RuntimeType, model?: string) => AgentDef;
}

const SEND_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per message
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // check every 30s

export type ReplyRoutingCallback = (fromAgent: string, toAgent: string, reply: string) => void;

export class FleetManager {
  private agents = new Map<string, LiveAgent>();
  private bus: FleetEventBus;
  private config: FleetManagerConfig;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private postReplyHook: ((agentName: string, reply: string, sender: MessageSender) => Promise<string>) | null = null;
  private replyRoutingCallback: ReplyRoutingCallback | null = null;

  constructor(bus: FleetEventBus, config: FleetManagerConfig) {
    this.bus = bus;
    this.config = config;
    this.startHealthCheck();
  }

  setPostReplyHook(hook: (agentName: string, reply: string, sender: MessageSender) => Promise<string>): void {
    this.postReplyHook = hook;
  }

  onReplyRouted(callback: ReplyRoutingCallback): void {
    this.replyRoutingCallback = callback;
  }

  private startHealthCheck(): void {
    this.healthInterval = setInterval(() => this.checkAgentHealth(), HEALTH_CHECK_INTERVAL_MS);
  }

  private checkAgentHealth(): void {
    const now = Date.now();
    for (const [name, live] of this.agents) {
      if (live.state.status === "working" && live.state.lastActivity) {
        const elapsed = now - new Date(live.state.lastActivity).getTime();
        if (elapsed > SEND_TIMEOUT_MS + 30_000) {
          // Agent has been "working" far longer than the timeout allows — mark dead
          live.state.status = "dead";
          live.state.inferred = `unresponsive for ${Math.round(elapsed / 60_000)}min — marked dead`;
          this.bus.publish("status_change", name, live.sessionId, { status: "dead" });
          this.logToSession(name, live.sessionId, {
            type: "health_check",
            status: "dead",
            elapsed_ms: elapsed,
          });
          live.processing = false;
          if (live.session) {
            try { live.session.close(); } catch {}
            live.session = null;
          }
          this.persistState();
          console.log(`[fleet] ${name}: marked DEAD after ${Math.round(elapsed / 60_000)}min unresponsive`);
        }
      }
    }
  }

  stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
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

  autoName(): string {
    return generateUniqueName(this.listAgents());
  }

  async spawn(name: string | undefined, runtime: RuntimeType, workspaceAlias: string, model?: string): Promise<string> {
    if (!name) name = this.autoName();
    if (this.agents.has(name)) {
      return `"${name}" already exists. Use /kill first.`;
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
      messageQueue: [],
      processing: false,
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

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${Math.round(ms / 1000)}s: ${label}`));
      }, ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  async send(name: string, text: string, sender: MessageSender = "user"): Promise<string> {
    const live = this.agents.get(name);
    if (!live) {
      return `Agent "${name}" not found. Use /new to spawn.`;
    }

    // If agent is currently processing, queue the message
    if (live.processing) {
      return new Promise((resolve, reject) => {
        live.messageQueue.push({ text, sender, resolve, reject });
        console.log(`[fleet] ${name}: queued message from ${sender} (queue: ${live.messageQueue.length})`);
      });
    }

    return this.processMessage(name, live, text, sender);
  }

  private async processMessage(name: string, live: LiveAgent, text: string, sender: MessageSender): Promise<string> {
    // Auto-recover from dead/error
    if (live.state.status === "dead" || live.state.status === "error") {
      console.log(`[fleet] ${name}: recovering from ${live.state.status} — creating fresh session`);
      if (live.session) {
        try { live.session.close(); } catch {}
        live.session = null;
      }
      live.state.status = "idle";
    }

    live.processing = true;
    live.state.status = "working";
    live.state.inferred = `processing message from ${sender}`;
    live.state.lastActivity = new Date().toISOString();
    if (sender === "user") live.state.lastUserMessage = text;

    // Tag message with sender for the agent to see
    const taggedText = sender === "user" ? text : `[from:${sender}] ${text}`;

    this.bus.publish("status_change", name, live.sessionId, { status: "working" });
    this.bus.publish("user_message", name, live.sessionId, { text: taggedText, sender });
    this.logToSession(name, live.sessionId, { type: "user_message", text: taggedText, sender });

    const attemptSend = async (isRetry: boolean): Promise<string> => {
      if (!live.session) {
        const sessionsDir = getSessionsDir(name);
        const sessionContext = this.buildSessionContext(name, sessionsDir);

        live.session = await this.withTimeout(
          live.runtime.createSession({
            cwd: live.state.workspacePath,
            model: live.state.model,
            context: sessionContext,
            name: `fleet-${name}-${live.sessionId}`,
          }),
          60_000,
          `${name} session creation`,
        );
        this.bus.publish("session_started", name, live.sessionId);
      }

      return this.withTimeout(
        live.session.send(taggedText),
        SEND_TIMEOUT_MS,
        `${name} send`,
      );
    };

    try {
      let reply: string;
      try {
        reply = await attemptSend(false);
      } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const isTimeout = firstMsg.includes("Timeout");
        console.log(`[fleet] ${name}: send failed (${isTimeout ? "TIMEOUT" : "error"}), retrying with fresh session...`);
        if (live.session) {
          try { live.session.close(); } catch {}
          live.session = null;
        }
        if (isTimeout) {
          live.state.status = "dead";
          live.state.inferred = `send timed out after ${SEND_TIMEOUT_MS / 60_000}min — session closed`;
          this.bus.publish("status_change", name, live.sessionId, { status: "dead" });
          this.logToSession(name, live.sessionId, { type: "timeout", error: firstMsg });
          this.persistState();
          this.finishProcessing(name, live);
          return `⚠️ Agent "${name}" timed out (${SEND_TIMEOUT_MS / 60_000}min). Session closed. Send another message to auto-recover.`;
        }
        reply = await attemptSend(true);
      }

      // Run post-reply hook (fleet tool execution)
      if (this.postReplyHook) {
        reply = await this.postReplyHook(name, reply, sender);
      }

      live.state.messageCount++;
      live.state.status = "idle";
      live.state.inferred = "idle — waiting for input";
      live.state.lastActivity = new Date().toISOString();
      live.state.lastAgentMessage = reply;
      this.bus.publish("agent_message", name, live.sessionId, { text: reply, sender });
      this.bus.publish("status_change", name, live.sessionId, { status: "idle" });
      this.logToSession(name, live.sessionId, { type: "agent_message", text: reply, replyTo: sender });
      this.persistState();

      if (!live.state.sessionName) {
        this.requestSessionName(name, live);
      }

      // Reply routing: if message was from another agent, route reply back
      if (sender !== "user") {
        this.routeReplyToSender(name, sender, reply);
      }

      this.finishProcessing(name, live);
      return reply;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errMsg.includes("Timeout");
      live.state.status = isTimeout ? "dead" : "error";
      live.state.inferred = isTimeout
        ? `send timed out — session closed, send message to recover`
        : `error: ${errMsg.slice(0, 80)}`;
      this.bus.publish("status_change", name, live.sessionId, { status: live.state.status });
      this.bus.publish("error", name, live.sessionId, { error: errMsg });
      this.logToSession(name, live.sessionId, { type: isTimeout ? "timeout" : "error", error: errMsg });
      this.persistState();

      if (live.session) {
        try { live.session.close(); } catch {}
        live.session = null;
      }

      this.finishProcessing(name, live);

      if (isTimeout) {
        return `⚠️ Agent "${name}" timed out. Session closed. Send another message to auto-recover.`;
      }

      throw err;
    }
  }

  private routeReplyToSender(fromAgent: string, toAgent: string, reply: string): void {
    const senderLive = this.agents.get(toAgent);
    if (!senderLive) {
      console.log(`[fleet] reply routing: sender "${toAgent}" no longer exists, skipping`);
      return;
    }

    // Log the reply in the sender's session
    this.logToSession(toAgent, senderLive.sessionId, {
      type: "peer_reply",
      from: fromAgent,
      text: reply,
    });

    // Notify via callback (Telegram notification)
    if (this.replyRoutingCallback) {
      this.replyRoutingCallback(fromAgent, toAgent, reply);
    }

    console.log(`[fleet] reply routed: ${fromAgent} → ${toAgent} (${reply.length} chars)`);
  }

  private finishProcessing(name: string, live: LiveAgent): void {
    live.processing = false;
    // Process next queued message if any
    if (live.messageQueue.length > 0) {
      const next = live.messageQueue.shift()!;
      console.log(`[fleet] ${name}: dequeuing message from ${next.sender} (remaining: ${live.messageQueue.length})`);
      this.processMessage(name, live, next.text, next.sender)
        .then(next.resolve)
        .catch(next.reject);
    }
  }

  private buildSessionContext(name: string, sessionsDir: string): string {
    const isDispatcher = name === "_dispatcher";
    const live = this.agents.get(name);
    const lines = [
      `You are agent "${name}" running in workspace: ${live?.state.workspacePath}`,
      `Your session history is stored at: ${sessionsDir}`,
      `Each file is a JSONL log (one JSON object per line with ts, type, text fields).`,
      `If the user asks to recall/search past conversations, read or grep these files.`,
      "",
      `Messages from other agents are prefixed with [from:agentname]. Respond naturally.`,
      "",
      getToolInstructions(isDispatcher),
    ];
    return lines.join("\n");
  }

  private requestSessionName(name: string, live: LiveAgent): void {
    if (!live.session) return;
    const prompt = live.state.sessionName
      ? `当前session名是"${live.state.sessionName}"。如果话题已变，用不超过10个字重新命名；否则回复同样的名字。只回复名字本身。`
      : "这个session还没有名字。用不超过10个字给它起个名字，概括我们在做什么。只回复名字本身，不要引号或其他内容。";

    live.session.send(prompt).then((nameReply) => {
      const raw = nameReply.trim().replace(/^["'""'']+|["'""'']+$/g, "").trim();
      const sessionName = raw.slice(0, 20);
      if (sessionName && sessionName.length <= 20) {
        live.state.sessionName = sessionName;
        this.bus.publish("session_named", name, live.sessionId, { sessionName });
        this.logToSession(name, live.sessionId, { type: "session_named", sessionName });
        this.persistState();
        console.log(`[fleet] ${name}: session named "${sessionName}"`);
      }
    }).catch((err) => {
      console.warn(`[fleet] ${name}: session naming failed: ${(err as Error).message?.slice(0, 60)}`);
    });
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
    live.state.sessionName = undefined;
    live.state.lastActivity = new Date().toISOString();

    this.bus.publish("session_cleared", name, oldSessionId, { newSessionId });
    this.persistState();

    return `Session cleared for "${name}". New session: ${newSessionId}`;
  }

  async change(name: string, field: string, value: string, config: BridgeConfig, workspaces: WorkspaceEntry[]): Promise<string> {
    const live = this.agents.get(name);
    if (!live) {
      return `Agent "${name}" not found.`;
    }

    if (live.processing) {
      return `Agent "${name}" is busy. Wait for it to finish.`;
    }

    switch (field) {
      case "model": {
        // Close current session (model change requires new session)
        if (live.session) {
          try { live.session.close(); } catch {}
          live.session = null;
        }
        live.state.model = value;
        // Rebuild runtime with new model
        const agentDef = this.config.getAgentDef(live.state.runtime as RuntimeType, value);
        live.runtime = this.config.createRuntime(agentDef);
        this.persistState();
        return `"${name}" model changed to ${value}. Session reset.`;
      }

      case "workspace": {
        const ws = workspaces.find((w) => w.alias === value);
        if (!ws) {
          return `Unknown workspace "${value}". Available: ${workspaces.map((w) => w.alias).join(", ")}`;
        }
        if (live.session) {
          try { live.session.close(); } catch {}
          live.session = null;
        }
        live.state.workspace = value;
        live.state.workspacePath = ws.path;
        this.persistState();
        return `"${name}" workspace changed to ${value} (${ws.path}). Session reset.`;
      }

      case "runtime": {
        const validRuntimes = ["cursor", "claude-code", "codex"];
        if (!validRuntimes.includes(value)) {
          return `Invalid runtime "${value}". Options: ${validRuntimes.join(", ")}`;
        }
        if (live.session) {
          try { live.session.close(); } catch {}
          live.session = null;
        }
        live.state.runtime = value as RuntimeType;
        const newDef = this.config.getAgentDef(value as RuntimeType);
        live.state.model = newDef.model;
        live.runtime = this.config.createRuntime(newDef);
        await this.config.ensureRulesSync(newDef);
        this.persistState();
        return `"${name}" switched to ${value} (${newDef.model}). Session reset.`;
      }

      default:
        return `Unknown field "${field}". Use: model, workspace, or runtime.`;
    }
  }

  isProcessing(name: string): boolean {
    return this.agents.get(name)?.processing ?? false;
  }

  getStatus(): { agents: AgentState[]; total: number; working: number; idle: number; dead: number } {
    const agents = Array.from(this.agents.values()).map((a) => a.state);
    return {
      agents,
      total: agents.length,
      working: agents.filter((a) => a.status === "working").length,
      idle: agents.filter((a) => a.status === "idle").length,
      dead: agents.filter((a) => a.status === "dead").length,
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

  addWorkspace(alias: string, path: string): string {
    const result = addWorkspaceToState(alias, path);
    if (!result.startsWith("Error")) {
      // Update in-memory workspace list
      const existing = this.config.workspaces.find((w) => w.alias === alias);
      if (existing) {
        existing.path = path;
      } else {
        this.config.workspaces.push({ alias, path });
      }
      this.bus.publish("status_change", "_system", "", { event: "workspace_added", alias, path });
    }
    return result;
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

      // On restart: "working" becomes "idle" (stale), "dead"/"error" preserved for visibility
      const restoredStatus = (agentState.status === "working") ? "idle" : agentState.status;
      this.agents.set(name, {
        state: { ...agentState, status: restoredStatus },
        runtime: runtimeInstance,
        session: null,
        sessionId: agentState.currentSessionId,
        messageQueue: [],
        processing: false,
      });

      console.log(`[fleet] restored "${name}" (${agentState.runtime} · ${agentState.workspace})`);
    }
  }
}
