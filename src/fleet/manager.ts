import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";
import type { AgentDef, BridgeConfig, RuntimeType, CommsMode, FleetTimeouts, ExternalConfig } from "../config.js";
import { DEFAULT_TIMEOUTS, DEFAULT_EXTERNAL } from "../config.js";
import type { Runtime, AgentSession } from "../runtimes/interface.js";
import { loadFleetState, saveFleetState, getSessionsDir, readRecentHistory, addWorkspace as addWorkspaceToState, removeWorkspace as removeWorkspaceFromState, renameWorkspace as renameWorkspaceInState, loadWorkspaces, recoverFromSessions, appendTaskLog, generateTaskId, reconstructTaskLedger, readTaskLog } from "./state.js";
import type { TaskLogEntry } from "./state.js";
import { generateUniqueName } from "./naming.js";
import { buildAgentPreamble, buildDispatcherPreamble, buildExternalPreamble } from "./preamble.js";
import { DISPATCHER_NAME } from "../utils/constants.js";
import { HealthMonitor } from "./health-monitor.js";
import type { ExternalPermissions } from "./chat-bindings.js";
import type { AgentState, AgentStatus, FleetEvent, FleetEventType, FleetState, QueuedMessage, MessageSender, WorkspaceEntry, FleetActivityEvent, FleetActivityType } from "./types.js";
export type { WorkspaceEntry } from "./types.js";

export class FleetEventBus extends EventEmitter {
  publish(type: FleetEventType, agentName: string, sessionId: string, payload?: unknown): void {
    const event: FleetEvent = {
      ts: new Date().toISOString(),
      type,
      agentName,
      sessionId,
      payload,
    };
    super.emit("fleet_event", event);
  }

  onEvent(listener: (data: FleetEvent) => void): this {
    return super.on("fleet_event", listener);
  }
}

const TRAITS = ["curious", "sleepy", "eager", "chaotic", "calm", "skeptical"] as const;
const ADJECTIVES = ["playful", "intense", "gentle", "wild", "stoic", "witty", "shy", "bold"] as const;

function generatePersonality(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  const trait = TRAITS[h % TRAITS.length];
  const adj = ADJECTIVES[(h >>> 8) % ADJECTIVES.length];
  return `${adj} · ${trait}`;
}

interface LiveAgent {
  state: AgentState;
  runtime: Runtime;
  session: AgentSession | null;
  sessionId: string;
  messageQueue: QueuedMessage[];
  processing: boolean;
}

interface ExternalSession {
  runtime: Runtime;
  session: AgentSession | null;
  sessionId: string;
  chatId: string;
  agentName: string;
  lastActivity: number;
  processing: boolean;
  messageQueue: QueuedMessage[];
}

export interface FleetManagerConfig {
  workspaces: WorkspaceEntry[];
  createRuntime: (agent: AgentDef) => Runtime;
  ensureRulesSync: (agent: AgentDef) => Promise<void>;
  getAgentDef: (runtime: RuntimeType, model?: string) => AgentDef;
  commsMode: CommsMode;
  timeouts?: FleetTimeouts;
  externalConfig?: ExternalConfig;
}


export interface OutgoingMediaItem {
  type: "photo" | "document";
  source: string;
  caption?: string;
  fileName?: string;
  agentName: string;
}

export type ReplyRoutingCallback = (fromAgent: string, toAgent: string, reply: string) => void;
export type PeerMessageCallback = (fromAgent: string, toAgent: string, direction: "sent" | "replied") => void;
export type DispatcherBroadcastCallback = (reply: string, triggerAgent: string) => void;
export type UserNotificationCallback = (text: string, level: string) => void;
export type FleetActivityCallback = (event: FleetActivityEvent) => void;
export type OutgoingMediaCallback = (media: OutgoingMediaItem) => void;

export interface TaskRecord {
  taskId: string;
  assignedAt: string;
  agent: string;
  task: string;
  status: "dispatched" | "completed" | "failed";
  completedAt?: string;
  result?: string;
  durationMs?: number;
}

export class FleetManager {
  private agents = new Map<string, LiveAgent>();
  private externalSessions = new Map<string, ExternalSession>();
  private bus: FleetEventBus;
  private config: FleetManagerConfig;
  private externalConfig: ExternalConfig;
  private healthMonitor: HealthMonitor;
  private postReplyHook: ((agentName: string, reply: string, sender: MessageSender) => Promise<import("./tools.js").PostReplyHookResult>) | null = null;
  private replyRoutingCallback: ReplyRoutingCallback | null = null;
  private peerMessageCallback: PeerMessageCallback | null = null;
  private dispatcherBroadcastCallback: DispatcherBroadcastCallback | null = null;
  private userNotificationCallback: UserNotificationCallback | null = null;
  private fleetActivityCallback: FleetActivityCallback | null = null;
  private outgoingMediaCallback: OutgoingMediaCallback | null = null;
  private taskLedger: TaskRecord[] = [];
  private workingStartedAt = new Map<string, number>();
  private repliedToDispatcher = new Set<string>();
  private recentFailures = new Map<string, number[]>(); // agent -> recent failure timestamps (retry-storm guard)

  constructor(bus: FleetEventBus, config: FleetManagerConfig) {
    this.bus = bus;
    this.config = config;
    this.externalConfig = config.externalConfig || DEFAULT_EXTERNAL;
    this.healthMonitor = new HealthMonitor(
      bus,
      () => this.agents as Map<string, any>,
      () => this.persistState(),
      config.timeouts,
    );
    this.healthMonitor.start();
  }

  get timeouts(): FleetTimeouts {
    return this.healthMonitor.timeouts;
  }

  setPostReplyHook(hook: (agentName: string, reply: string, sender: MessageSender) => Promise<import("./tools.js").PostReplyHookResult>): void {
    this.postReplyHook = hook;
  }

  onReplyRouted(callback: ReplyRoutingCallback): void {
    this.replyRoutingCallback = callback;
  }

  onPeerMessage(callback: PeerMessageCallback): void {
    this.peerMessageCallback = callback;
  }

  onDispatcherBroadcast(callback: DispatcherBroadcastCallback): void {
    this.dispatcherBroadcastCallback = callback;
  }

  onUserNotification(callback: UserNotificationCallback): void {
    this.userNotificationCallback = callback;
  }

  emitUserNotification(text: string, level: string): void {
    this.userNotificationCallback?.(text, level);
  }

  onFleetActivity(callback: FleetActivityCallback): void {
    this.fleetActivityCallback = callback;
  }

  emitFleetActivity(type: FleetActivityType, agent: string, detail: Record<string, unknown> = {}): void {
    this.fleetActivityCallback?.({ type, agent, detail });
  }

  onOutgoingMedia(callback: OutgoingMediaCallback): void {
    this.outgoingMediaCallback = callback;
  }

  queueOutgoingMedia(agentName: string, media: { type: "photo" | "document"; source: string; caption?: string; fileName?: string }): void {
    const item: OutgoingMediaItem = { ...media, agentName };
    this.outgoingMediaCallback?.(item);
  }

  getWorkingElapsed(name: string): number | null {
    const started = this.workingStartedAt.get(name);
    if (!started) return null;
    return Date.now() - started;
  }

  recordTask(agent: string, task: string): string {
    const taskId = generateTaskId();
    const now = new Date().toISOString();
    this.taskLedger.push({
      taskId,
      assignedAt: now,
      agent,
      task: task.slice(0, 200),
      status: "dispatched",
    });
    if (this.taskLedger.length > 100) {
      this.taskLedger = this.taskLedger.slice(-50);
    }
    appendTaskLog({ ts: now, event: "dispatched", taskId, agent, task: task.slice(0, 200), from: DISPATCHER_NAME });
    return taskId;
  }

  completeTask(agent: string, status: "completed" | "failed", result?: string): void {
    for (let i = this.taskLedger.length - 1; i >= 0; i--) {
      const rec = this.taskLedger[i];
      if (rec.agent === agent && rec.status === "dispatched") {
        const now = new Date().toISOString();
        rec.status = status;
        rec.completedAt = now;
        if (result) rec.result = result.slice(0, 100);
        rec.durationMs = new Date(now).getTime() - new Date(rec.assignedAt).getTime();
        appendTaskLog({
          ts: now, event: status, taskId: rec.taskId, agent,
          durationMs: rec.durationMs, result: result?.slice(0, 100),
        });
        break;
      }
    }
  }

  getRecentTaskLog(limit = 20): string {
    let recent = this.taskLedger.slice(-limit);

    if (recent.length === 0) {
      const fromDisk = reconstructTaskLedger(limit);
      if (fromDisk.length === 0) return "No tasks recorded yet.";
      recent = fromDisk;
    }

    const completed = recent.filter((t) => t.status === "completed").length;
    const failed = recent.filter((t) => t.status === "failed").length;
    const pending = recent.filter((t) => t.status === "dispatched").length;
    const header = `Tasks: ${completed} completed, ${failed} failed, ${pending} pending`;

    const formatDuration = (ms?: number): string => {
      if (!ms) return "";
      if (ms < 60_000) return ` (${Math.round(ms / 1000)}s)`;
      return ` (${Math.round(ms / 60_000)}m)`;
    };

    const lines = recent.map((t) => {
      const status = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "…";
      const result = t.result ? ` → ${t.result}` : "";
      const dur = formatDuration(t.durationMs);
      return `  ${status} ${t.agent}: ${t.task.slice(0, 80)}${dur}${result}`;
    });

    return `${header}\n${lines.join("\n")}`;
  }

  getTaskLogRaw(limit = 50): TaskRecord[] {
    if (this.taskLedger.length > 0) {
      return this.taskLedger.slice(-limit);
    }
    return reconstructTaskLedger(limit);
  }

  getTaskLogEntries(limit = 50): TaskLogEntry[] {
    return readTaskLog(limit);
  }

  getTaskLedgerSummary(): string {
    const recent = this.taskLedger.slice(-20);
    if (recent.length === 0) return "";

    const completed = recent.filter((t) => t.status === "completed");
    const failed = recent.filter((t) => t.status === "failed");
    const pending = recent.filter((t) => t.status === "dispatched");

    const parts: string[] = [];
    if (completed.length > 0) {
      parts.push(`${completed.length} completed: ${completed.map((t) => `${t.agent}(${t.task.slice(0, 40)})`).join(", ")}`);
    }
    if (failed.length > 0) {
      parts.push(`${failed.length} failed: ${failed.map((t) => t.agent).join(", ")}`);
    }
    if (pending.length > 0) {
      parts.push(`${pending.length} pending`);
    }
    return parts.join(" | ");
  }

  stopHealthCheck(): void {
    this.healthMonitor.stop();
  }

  async gracefulShutdown(): Promise<void> {
    console.log(`[fleet] graceful shutdown — persisting state and closing sessions...`);
    this.healthMonitor.stop();
    this.persistState();

    for (const [name, live] of this.agents) {
      if (live.session) {
        try {
          await live.session.close();
          console.log(`[fleet] closed session for "${name}"`);
        } catch (err) {
          console.warn(`[fleet] failed to close session for "${name}": ${(err as Error).message}`);
        }
      }
    }
    this.persistState();
    console.log(`[fleet] shutdown complete — ${this.agents.size} agents persisted`);
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

  renameWorkspace(oldAlias: string, newAlias: string): string {
    const result = renameWorkspaceInState(oldAlias, newAlias);
    if (result.startsWith("Error") || result.includes("not found")) return result;
    for (const [, live] of this.agents) {
      if (live.state.workspace === oldAlias) {
        live.state.workspace = newAlias;
      }
    }
    const idx = this.config.workspaces.findIndex((w) => w.alias === oldAlias);
    if (idx >= 0) this.config.workspaces[idx].alias = newAlias;
    this.persistState();
    this.bus.publish("status_change", "_system", "", { event: "workspace_renamed", oldAlias, newAlias });
    return result;
  }

  removeWorkspace(alias: string): string {
    const result = removeWorkspaceFromState(alias);
    if (result.includes("not found")) return result;
    const idx = this.config.workspaces.findIndex((w) => w.alias === alias);
    if (idx >= 0) this.config.workspaces.splice(idx, 1);
    this.bus.publish("status_change", "_system", "", { event: "workspace_removed", alias });
    return result;
  }

  listWorkspaces(): WorkspaceEntry[] {
    return this.config.workspaces;
  }

  setTitle(name: string, title: string): string {
    const live = this.agents.get(name);
    if (!live) return `"${name}" not found.`;
    live.state.title = title || undefined;
    this.persistState();
    this.bus.publish("status_change", name, live.sessionId, { title });
    return `"${name}" title set to "${title}"`;
  }

  private getDispatcherWorkspacePath(): string | null {
    const disp = this.agents.get(DISPATCHER_NAME);
    return disp?.state.workspacePath || null;
  }

  setGoal(goal: string): void {
    const wsPath = this.getDispatcherWorkspacePath();
    if (!wsPath) return;
    const goalPath = join(wsPath, "memory", "goal.md");
    writeFileSync(goalPath, goal);
  }

  getGoal(): string {
    const wsPath = this.getDispatcherWorkspacePath();
    if (!wsPath) return "";
    const goalPath = join(wsPath, "memory", "goal.md");
    if (!existsSync(goalPath)) return "";
    return readFileSync(goalPath, "utf-8").trim();
  }

  async spawn(name: string | undefined, runtime: RuntimeType, workspaceAlias: string, model?: string): Promise<string> {
    if (!name) name = this.autoName();
    if (this.agents.has(name)) {
      return `"${name}" already exists. Send it a message to wake it, or use /kill first to remove.`;
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

    // For the dispatcher, generate a display name so it has a consistent identity
    const displayName = name === DISPATCHER_NAME ? generateUniqueName([]) : undefined;

    const agentState: AgentState = {
      name,
      displayName,
      personality: generatePersonality(displayName || name),
      runtime,
      model: agentDef.model,
      workspace: workspaceAlias,
      workspacePath,
      status: "waiting",
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

  async respawn(name: string): Promise<string> {
    const live = this.agents.get(name);
    if (!live) {
      return `Agent "${name}" not found — cannot respawn.`;
    }

    // Close stale session
    if (live.session) {
      try { live.session.close(); } catch {}
      live.session = null;
    }

    // Recreate runtime instance (same as spawn does) — ensures clean SDK state
    const agentDef = this.config.getAgentDef(live.state.runtime as RuntimeType, live.state.model);
    live.runtime = this.config.createRuntime(agentDef);

    // Fresh session ID (same as spawn does)
    const newSessionId = this.generateSessionId();
    live.sessionId = newSessionId;
    live.state.currentSessionId = newSessionId;

    // Reset to waiting, keep identity (name, personality, workspace, title, memory)
    live.processing = false;
    live.messageQueue = [];
    live.state.status = "waiting";
    live.state.inferred = "respawned — ready for messages";
    live.state.lastActivity = new Date().toISOString();

    this.bus.publish("status_change", name, live.sessionId, { status: "waiting", event: "respawn" });
    this.persistState();

    console.log(`[fleet] ${name}: respawned (fresh runtime + session, identity preserved)`);
    return `Agent "${name}" respawned. Identity, workspace, and memory preserved.`;
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

    // Track tasks dispatched by the dispatcher to other agents
    if (sender === DISPATCHER_NAME && name !== DISPATCHER_NAME) {
      this.recordTask(name, text);
    }

    // Track when a throng explicitly sends a reply back to the dispatcher
    if (name === DISPATCHER_NAME && sender !== "user" && sender !== "system") {
      this.repliedToDispatcher.add(sender as string);
    }

    // Notify about peer-to-peer messages (not user→agent)
    if (sender !== "user" && this.peerMessageCallback) {
      this.peerMessageCallback(sender as string, name, "sent");
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
    // Auto-recover from dead/error/sleeping — full reset equivalent to spawn
    if (live.state.status === "dead" || live.state.status === "error" || live.state.status === "sleeping") {
      console.log(`[fleet] ${name}: waking from ${live.state.status} — creating fresh runtime + session`);
      if (live.session) {
        try { live.session.close(); } catch {}
        live.session = null;
      }
      // Recreate runtime to ensure clean SDK state (same as spawn/respawn)
      const agentDef = this.config.getAgentDef(live.state.runtime as RuntimeType, live.state.model);
      live.runtime = this.config.createRuntime(agentDef);
      live.state.status = "waiting";
    }

    // Proactive staleness check: if session has been idle too long, close it
    // to avoid "empty response" errors from stale Cursor SDK connections
    if (live.session && live.state.lastActivity) {
      const idleMs = Date.now() - new Date(live.state.lastActivity).getTime();
      if (idleMs > this.timeouts.sessionMaxAgeMs) {
        console.log(`[fleet] ${name}: session idle for ${Math.round(idleMs / 60_000)}min — closing, will reconnect on next message`);
        try { live.session.close(); } catch {}
        live.session = null;
      }
    }

    live.processing = true;
    live.state.status = "working";
    live.state.inferred = `processing message from ${sender}`;
    live.state.lastActivity = new Date().toISOString();
    this.workingStartedAt.set(name, Date.now());
    this.repliedToDispatcher.delete(name);
    if (sender === "user") {
      live.state.lastUserMessage = text;
      live.state.lastUserMessageAt = new Date().toISOString();
    }

    // Tag message with sender for the agent to see
    const taggedText = sender === "user" ? text : `[from:${sender}] ${text}`;

    this.bus.publish("status_change", name, live.sessionId, { status: "working" });
    if (name !== DISPATCHER_NAME) {
      this.emitFleetActivity("agent_waking", name, { from: sender, task: text.slice(0, 80) });
    }
    this.bus.publish("user_message", name, live.sessionId, { text: taggedText, sender });
    this.logToSession(name, live.sessionId, { type: "user_message", text: taggedText, sender });

    const attemptSend = async (): Promise<string> => {
      const isNewSession = !live.session;
      if (isNewSession) {
        live.session = await this.withTimeout(
          live.runtime.createSession({
            cwd: live.state.workspacePath,
            model: live.state.model,
            name: `fleet-${name}-${live.sessionId}`,
          }),
          60_000,
          `${name} session creation`,
        );
        this.bus.publish("session_started", name, live.sessionId);
      }

      const preamble = isNewSession ? this.buildPreamble(name) : "";
      const finalText = preamble ? `${preamble}\n\n---\n\n${taggedText}` : taggedText;

      return this.withTimeout(
        live.session!.send(finalText),
        this.timeouts.sendTimeoutMs,
        `${name} send`,
      );
    };

    const closeSession = () => {
      if (live.session) {
        try { live.session.close(); } catch {}
        live.session = null;
      }
    };

    try {
      let reply: string;
      let lastErr: Error | null = null;

      const MAX_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          reply = await attemptSend();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          const isTimeout = lastErr.message.includes("Timeout");
          console.log(`[fleet] ${name}: attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${isTimeout ? "TIMEOUT" : lastErr.message.slice(0, 80)})`);
          closeSession();
          this.logToSession(name, live.sessionId, { type: isTimeout ? "timeout" : "error", error: lastErr.message, attempt: attempt + 1 });

          if (isTimeout && attempt < MAX_ATTEMPTS - 1) {
            live.state.status = "sleeping";
            live.state.inferred = `timeout retry ${attempt + 1}/${MAX_ATTEMPTS} — retrying silently`;
            this.persistState();
            console.log(`[fleet] ${name}: silent timeout retry ${attempt + 2}/${MAX_ATTEMPTS}...`);
            continue;
          }

          if (isTimeout) {
            live.state.status = "dead";
            live.state.inferred = `send timed out ${MAX_ATTEMPTS}x — session closed`;
            this.bus.publish("status_change", name, live.sessionId, { status: "dead" });
            this.completeTask(name, "failed", `timeout ${MAX_ATTEMPTS}x`);
            if (name !== DISPATCHER_NAME) {
              this.emitFleetActivity("agent_timeout", name, { attempts: MAX_ATTEMPTS });
              this.workingStartedAt.delete(name);
            }
            this.persistState();
            this.finishProcessing(name, live);
            return `⚠️ Agent "${name}" timed out ${MAX_ATTEMPTS}x. Session closed. Send another message to auto-recover.`;
          }

          if (attempt < MAX_ATTEMPTS - 1) {
            console.log(`[fleet] ${name}: retrying with fresh session...`);
          }
        }
      }

      if (lastErr) {
        throw lastErr;
      }

      // Run post-reply hook (fleet tool execution) with re-prompt loop
      if (this.postReplyHook) {
        const MAX_REPROMPTS = 1;
        let repromptCount = 0;
        let hookResult = await this.postReplyHook(name, reply!, sender);
        reply = hookResult.narrative;

        while (hookResult.reprompt && repromptCount < MAX_REPROMPTS && live.session) {
          repromptCount++;
          console.log(`[fleet] ${name}: re-prompting (attempt ${repromptCount}/${MAX_REPROMPTS}) — ${hookResult.reprompt.slice(0, 60)}...`);
          this.logToSession(name, live.sessionId, { type: "system_reprompt", text: hookResult.reprompt, attempt: repromptCount });

          try {
            const correctionReply = await this.withTimeout(
              live.session.send(hookResult.reprompt),
              this.timeouts.sendTimeoutMs,
              `${name} re-prompt`,
            );
            hookResult = await this.postReplyHook(name, correctionReply, sender);
            reply = hookResult.narrative || reply;
            console.log(`[fleet] ${name}: re-prompt ${repromptCount} got reply (${correctionReply.length} chars), tools extracted`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn(`[fleet] ${name}: re-prompt failed: ${errMsg.slice(0, 80)}`);
            break;
          }
        }

        if (hookResult.reprompt && repromptCount >= MAX_REPROMPTS) {
          console.warn(`[fleet] ${name}: re-prompt exhausted (${MAX_REPROMPTS} attempts) — dispatch may have been missed`);
        }
      }

      live.state.messageCount++;
      live.state.status = "waiting";
      live.state.inferred = "idle — ready for next task";
      live.state.lastActivity = new Date().toISOString();
      live.state.lastAgentMessage = reply!;
      this.bus.publish("agent_message", name, live.sessionId, { text: reply!, sender });
      this.bus.publish("status_change", name, live.sessionId, { status: "waiting" });
      this.logToSession(name, live.sessionId, { type: "agent_message", text: reply!, replyTo: sender });

      if (sender === DISPATCHER_NAME && name !== DISPATCHER_NAME) {
        this.completeTask(name, "completed", reply!);
      }

      if (name !== DISPATCHER_NAME) {
        const elapsed = this.getWorkingElapsed(name);
        this.emitFleetActivity("agent_completed", name, {
          elapsedMs: elapsed,
          replyPreview: reply!.slice(0, 120),
        });
        this.workingStartedAt.delete(name);

        // Auto-forward completion to dispatcher if the throng didn't explicitly report back.
        // This ensures the dispatcher always knows when assigned tasks finish.
        if (sender === DISPATCHER_NAME && !this.repliedToDispatcher.has(name)) {
          const preview = reply!.slice(0, 200);
          const summary = `[system] ${name} completed your task. Reply: ${preview}${reply!.length > 200 ? "…" : ""}`;
          console.log(`[fleet] auto-forwarding ${name}'s completion to dispatcher (no explicit fleet_send back)`);
          this.send(DISPATCHER_NAME, summary, name as MessageSender).catch((err) => {
            console.warn(`[fleet] auto-forward to dispatcher failed: ${(err as Error).message?.slice(0, 60)}`);
          });
        }
        this.repliedToDispatcher.delete(name);
      }

      this.persistState();

      // Reply routing: if message was from another agent, route reply back
      if (sender !== "user") {
        this.routeReplyToSender(name, sender, reply!);

        // Broadcast dispatcher replies to TG only for peer agent messages,
        // NOT for system-initiated messages (IDLE_POKE, error reports)
        if (name === DISPATCHER_NAME && this.dispatcherBroadcastCallback && reply!.trim() && sender !== "system") {
          this.dispatcherBroadcastCallback(reply!, sender as string);
        }
      }

      // Session naming takes over `processing` to prevent concurrent sends.
      // If naming fires, it will call finishProcessing when done.
      if (!live.state.sessionName && live.messageQueue.length === 0) {
        this.requestSessionName(name, live);
      } else {
        this.finishProcessing(name, live);
      }
      return reply!;
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
      this.completeTask(name, "failed", errMsg.slice(0, 100));
      if (name !== DISPATCHER_NAME) {
        this.emitFleetActivity(isTimeout ? "agent_timeout" : "agent_died", name, {
          error: errMsg.slice(0, 100),
        });
        this.workingStartedAt.delete(name);
        this.repliedToDispatcher.delete(name);
      }
      this.persistState();

      closeSession();

      // Forward non-timeout errors to dispatcher (timeouts are retried silently by the platform)
      if (name !== DISPATCHER_NAME && !isTimeout) {
        const nowTs = Date.now();
        const fails = (this.recentFailures.get(name) || []).filter((t) => nowTs - t < 5 * 60 * 1000);
        fails.push(nowTs);
        this.recentFailures.set(name, fails);
        const dispLive = this.agents.get(DISPATCHER_NAME);
        if (fails.length > 2) {
          console.warn(`[fleet] ${name}: ${fails.length} failures in 5min — suppressing dispatcher notification (retry-storm guard)`);
        } else if (dispLive && dispLive.state.status !== "error" && dispLive.state.status !== "dead") {
          const briefErr = errMsg.length > 200 ? errMsg.slice(0, 200) + "…" : errMsg;
          this.send(DISPATCHER_NAME, `Agent "${name}" hit an error: ${briefErr}\nStatus: ${live.state.status}. It will auto-recover when you send it another message — just re-send the task. Do NOT kill or re-hatch.`, name)
            .catch((e) => console.warn(`[fleet] failed to notify dispatcher of ${name} error: ${(e as Error).message?.slice(0, 60)}`));
        } else {
          console.warn(`[fleet] ${name}: error occurred but dispatcher is ${dispLive?.state.status ?? "absent"} — skipping error forwarding`);
        }
      }

      this.finishProcessing(name, live);

      if (isTimeout) {
        return `⚠️ Agent "${name}" timed out. Session closed. Send another message to auto-recover.`;
      }

      // Return error message instead of throwing — prevents unhandled rejections
      // from cascading through the message queue
      return `⚠️ Agent "${name}" error: ${errMsg.slice(0, 200)}`;
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

    // Notify via callback (Telegram notification — content)
    if (this.replyRoutingCallback) {
      this.replyRoutingCallback(fromAgent, toAgent, reply);
    }

    // Notify peer message event (metadata only, no content)
    if (this.peerMessageCallback) {
      this.peerMessageCallback(fromAgent, toAgent, "replied");
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

  buildPreamble(name: string): string {
    const live = this.agents.get(name);
    if (!live) return "";
    const sessionsDir = getSessionsDir(name);
    const history = readRecentHistory(name, 10);

    if (name === DISPATCHER_NAME) {
      return buildDispatcherPreamble(
        this.getStatus(), this.config.workspaces, sessionsDir,
        this.getGoal(), live.state.displayName || "Dispatcher", history,
      );
    }

    return buildAgentPreamble(name, live.state, sessionsDir, this.config.commsMode, history);
  }

  private requestSessionName(name: string, live: LiveAgent): void {
    if (!live.session) return;
    // Skip naming if messages are queued — avoid concurrent sends on the session
    if (live.messageQueue.length > 0) return;

    const prompt = live.state.sessionName
      ? `当前session名是"${live.state.sessionName}"。如果话题已变，用不超过10个字重新命名；否则回复同样的名字。只回复名字本身。`
      : "这个session还没有名字。用不超过10个字给它起个名字，概括我们在做什么。只回复名字本身，不要引号或其他内容。";

    // Mark processing to prevent dequeued messages from racing with this send
    live.processing = true;
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
    }).finally(() => {
      this.finishProcessing(name, live);
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
    live.state.status = "waiting";
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

  getStatus(): { agents: AgentState[]; total: number; working: number; waiting: number; sleeping: number; dead: number } {
    const agents = Array.from(this.agents.values()).map((a) => a.state);
    return {
      agents,
      total: agents.length,
      working: agents.filter((a) => a.status === "working").length,
      waiting: agents.filter((a) => a.status === "waiting").length,
      sleeping: agents.filter((a) => a.status === "sleeping").length,
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

  private externalSessionKey(agentName: string, chatId: string): string {
    return `${agentName}:${chatId}`;
  }

  async sendExternal(
    agentName: string,
    chatId: string,
    text: string,
    permissions: ExternalPermissions,
    username?: string,
  ): Promise<string> {
    const live = this.agents.get(agentName);
    if (!live) {
      return `Agent "${agentName}" is not available right now.`;
    }

    const key = this.externalSessionKey(agentName, chatId);
    let extSession = this.externalSessions.get(key);

    if (extSession && extSession.processing) {
      return new Promise((resolve, reject) => {
        extSession!.messageQueue.push({ text, sender: `ext:${chatId}`, resolve, reject });
        console.log(`[fleet] ${agentName}: queued external message from ${chatId} (queue: ${extSession!.messageQueue.length})`);
      });
    }

    if (!extSession) {
      const agentDef = this.config.getAgentDef(live.state.runtime as RuntimeType, live.state.model);
      const runtime = this.config.createRuntime(agentDef);
      const sessionId = `ext-${chatId}-${this.generateSessionId()}`;

      extSession = {
        runtime,
        session: null,
        sessionId,
        chatId,
        agentName,
        lastActivity: Date.now(),
        processing: false,
        messageQueue: [],
      };
      this.externalSessions.set(key, extSession);
    }

    // Check staleness — external sessions have shorter timeout
    const idleMs = Date.now() - extSession.lastActivity;
    if (extSession.session && idleMs > this.externalConfig.sessionMaxAgeMs) {
      console.log(`[fleet] ${agentName}: external session for ${chatId} idle ${Math.round(idleMs / 60_000)}min — closing`);
      try { extSession.session.close(); } catch {}
      extSession.session = null;
    }

    return this.processExternalMessage(agentName, extSession, text, permissions, username);
  }

  private async processExternalMessage(
    agentName: string,
    ext: ExternalSession,
    text: string,
    permissions: ExternalPermissions,
    username?: string,
  ): Promise<string> {
    const live = this.agents.get(agentName);
    if (!live) return `Agent "${agentName}" is not available.`;

    ext.processing = true;
    ext.lastActivity = Date.now();

    this.logToSession(agentName, ext.sessionId, {
      type: "external_message",
      chatId: ext.chatId,
      username,
      text,
    });

    try {
      const isNewSession = !ext.session;
      if (isNewSession) {
        const agentDef = this.config.getAgentDef(live.state.runtime as RuntimeType, live.state.model);
        if (!ext.runtime) {
          ext.runtime = this.config.createRuntime(agentDef);
        }
        ext.session = await this.withTimeout(
          ext.runtime.createSession({
            cwd: live.state.workspacePath,
            model: live.state.model,
            name: `ext-${agentName}-${ext.chatId.slice(-6)}`,
          }),
          60_000,
          `${agentName} external session creation`,
        );
      }

      const preamble = isNewSession
        ? buildExternalPreamble(agentName, live.state, permissions, username)
        : "";
      const finalText = preamble ? `${preamble}\n\n---\n\n${text}` : text;

      let reply = await this.withTimeout(
        ext.session!.send(finalText),
        this.timeouts.sendTimeoutMs,
        `${agentName} external send`,
      );

      // Strip any fleet markers from external replies — external sessions must not execute fleet tools
      reply = reply.replace(/\[FLEET:\w+:\{[\s\S]*?\}\]/g, "").trim();

      this.logToSession(agentName, ext.sessionId, {
        type: "external_reply",
        chatId: ext.chatId,
        text: reply,
      });

      return reply;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[fleet] ${agentName}: external session error for ${ext.chatId}: ${errMsg.slice(0, 100)}`);

      if (ext.session) {
        try { ext.session.close(); } catch {}
        ext.session = null;
      }

      this.logToSession(agentName, ext.sessionId, {
        type: "external_error",
        chatId: ext.chatId,
        error: errMsg,
      });

      return `Sorry, I encountered an error. Please try again in a moment.`;
    } finally {
      ext.processing = false;
      if (ext.messageQueue.length > 0) {
        const next = ext.messageQueue.shift()!;
        this.processExternalMessage(agentName, ext, next.text, permissions, username)
          .then(next.resolve)
          .catch(next.reject);
      }
    }
  }

  cleanupExternalSessions(): void {
    const maxAge = this.externalConfig.sessionMaxAgeMs;
    const now = Date.now();
    for (const [key, ext] of this.externalSessions) {
      if (now - ext.lastActivity > maxAge && !ext.processing) {
        if (ext.session) {
          try { ext.session.close(); } catch {}
        }
        this.externalSessions.delete(key);
        console.log(`[fleet] cleaned up external session ${key}`);
      }
    }
  }

  async restore(): Promise<void> {
    // Restore task ledger from persistent JSONL
    const diskLedger = reconstructTaskLedger(50);
    if (diskLedger.length > 0) {
      this.taskLedger = diskLedger;
      console.log(`[fleet] restored ${diskLedger.length} task records from task-log.jsonl`);
    }

    let saved = loadFleetState();

    // If state is empty, attempt recovery from session directories
    if (!Object.keys(saved.agents).length) {
      console.log(`[fleet] state is empty — attempting recovery from session directories...`);
      saved = recoverFromSessions(this.config.workspaces);
      if (Object.keys(saved.agents).length > 0) {
        saveFleetState(saved);
        console.log(`[fleet] recovered and saved ${Object.keys(saved.agents).length} agents`);
      } else {
        return;
      }
    }

    console.log(`[fleet] restoring ${Object.keys(saved.agents).length} agents from state...`);
    for (const [name, agentState] of Object.entries(saved.agents)) {
      let workspacePath = this.resolveWorkspace(agentState.workspace);
      if (!workspacePath) {
        // Workspace alias not registered — use saved workspacePath if available
        if (agentState.workspacePath) {
          workspacePath = agentState.workspacePath;
          console.warn(`[fleet] "${name}" workspace alias "${agentState.workspace}" not registered — using saved path: ${workspacePath}`);
          // Re-register the workspace so agent can function
          this.config.workspaces.push({ alias: agentState.workspace, path: workspacePath });
        } else {
          console.warn(`[fleet] skipping "${name}" — workspace "${agentState.workspace}" has no saved path`);
          continue;
        }
      }

      const agentDef = this.config.getAgentDef(agentState.runtime as RuntimeType);
      const runtimeInstance = this.config.createRuntime(agentDef);

      // Use the config's model, not the saved one (which could be stale or from tests)
      const resolvedModel = agentDef.model || agentState.model;
      if (agentState.model !== resolvedModel) {
        console.log(`[fleet] "${name}" model updated: ${agentState.model} → ${resolvedModel}`);
      }

      // On restart: any non-stopped state becomes sleeping (session is gone)
      const rawStatus = agentState.status as string;
      const restoredStatus: AgentStatus = rawStatus === "stopped" ? "stopped" : "sleeping";
      this.agents.set(name, {
        state: { ...agentState, status: restoredStatus, model: resolvedModel },
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
