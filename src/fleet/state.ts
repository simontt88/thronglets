import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FleetState, AgentState, WorkspaceEntry } from "./types.js";
import { GLOBAL_CONFIG_DIR } from "../config.js";

const THRONGLETS_HOME = GLOBAL_CONFIG_DIR;
const FLEET_DIR = join(THRONGLETS_HOME, "fleet");
const STATE_FILE = join(FLEET_DIR, "fleet-state.json");
const STATE_BACKUP = STATE_FILE + ".bak";
const WORKSPACES_FILE = join(THRONGLETS_HOME, "workspaces.yaml");

let _testDir: string | null = null;

export function _setTestDir(dir: string | null): void {
  _testDir = dir;
}

function getStateFile(): string {
  return _testDir ? join(_testDir, "fleet-state.json") : STATE_FILE;
}

function getBackupFile(): string {
  return _testDir ? join(_testDir, "fleet-state.json.bak") : STATE_BACKUP;
}

function resolveFleetDir(): string {
  return _testDir ? _testDir : FLEET_DIR;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadFleetState(): FleetState {
  const fleetDir = resolveFleetDir();
  const stateFile = getStateFile();
  const backupFile = getBackupFile();
  ensureDir(fleetDir);

  if (existsSync(stateFile)) {
    try {
      const raw = readFileSync(stateFile, "utf-8");
      const state = JSON.parse(raw) as FleetState;
      if (Object.keys(state.agents).length > 0) {
        return state;
      }
    } catch {
      console.warn(`[state] failed to parse ${stateFile}, trying backup...`);
    }
  }

  // State is empty or missing — try backup
  if (existsSync(backupFile)) {
    try {
      const raw = readFileSync(backupFile, "utf-8");
      const state = JSON.parse(raw) as FleetState;
      if (Object.keys(state.agents).length > 0) {
        console.log(`[state] recovered ${Object.keys(state.agents).length} agents from backup`);
        return state;
      }
    } catch {
      console.warn(`[state] backup also unreadable`);
    }
  }

  return { agents: {}, version: 1, lastUpdated: new Date().toISOString() };
}

export function saveFleetState(state: FleetState): void {
  const fleetDir = resolveFleetDir();
  const stateFile = getStateFile();
  const backupFile = getBackupFile();
  ensureDir(fleetDir);
  state.lastUpdated = new Date().toISOString();

  // Backup current state before overwriting (only if it has real agents)
  if (existsSync(stateFile)) {
    try {
      const existing = JSON.parse(readFileSync(stateFile, "utf-8")) as FleetState;
      if (Object.keys(existing.agents).length > 0) {
        copyFileSync(stateFile, backupFile);
      }
    } catch { /* ignore backup failures */ }
  }

  const tmp = stateFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}

export function recoverFromSessions(workspaces: WorkspaceEntry[]): FleetState {
  const sessionsDir = join(FLEET_DIR, "sessions");
  if (!existsSync(sessionsDir)) {
    return { agents: {}, version: 1, lastUpdated: new Date().toISOString() };
  }

  const agentDirs = readdirSync(sessionsDir).filter((d) => {
    try { return statSync(join(sessionsDir, d)).isDirectory(); } catch { return false; }
  });

  // Skip test artifacts and already-recovered agents
  const skipNames = new Set(["alpha", "beta", "gamma", "lala", "lila", "lilo", "stuart"]);
  const agents: Record<string, AgentState> = {};
  const wsMap = new Map(workspaces.map((w) => [w.path, w.alias]));

  for (const name of agentDirs) {
    if (skipNames.has(name.toLowerCase())) continue;

    const dir = join(sessionsDir, name);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    if (files.length === 0) continue;

    // Read the most recent session to extract metadata
    let lastActivity = "";
    let sessionName = "";
    let lastUserMessage = "";
    let lastAgentMessage = "";
    let workspace = "";
    let workspacePath = "";

    const latestFile = join(dir, files[0]);
    try {
      const content = readFileSync(latestFile, "utf-8").trim();
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.ts) lastActivity = entry.ts;
          if (entry.type === "session_named") sessionName = entry.sessionName || "";
          if (entry.type === "user_message") lastUserMessage = (entry.text || "").slice(0, 200);
          if (entry.type === "agent_message") lastAgentMessage = (entry.text || "").slice(0, 200);
        } catch { /* skip */ }
      }
    } catch { continue; }

    if (!lastActivity) continue;

    // Skip sessions older than 7 days
    const age = Date.now() - new Date(lastActivity).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) continue;

    // Try to match workspace from session data
    for (const [path, alias] of wsMap) {
      if (lastUserMessage.includes(path) || lastAgentMessage.includes(path)) {
        workspace = alias;
        workspacePath = path;
        break;
      }
    }

    // For dispatcher, use "dispatch" workspace
    if (name === "_dispatcher") {
      workspace = "dispatch";
      const wsEntry = workspaces.find((w) => w.alias === "dispatch");
      workspacePath = wsEntry?.path || "";
    }

    agents[name] = {
      name,
      runtime: "cursor",
      model: "",
      workspace,
      workspacePath,
      status: "sleeping",
      currentSessionId: files[0].replace(".jsonl", ""),
      spawnedAt: lastActivity,
      lastActivity,
      messageCount: files.length,
      sessionName: sessionName || undefined,
      lastUserMessage: lastUserMessage || undefined,
      lastAgentMessage: lastAgentMessage || undefined,
    };
  }

  const recovered = Object.keys(agents).length;
  if (recovered > 0) {
    console.log(`[state] recovered ${recovered} agents from session directories`);
  }

  return { agents, version: 1, lastUpdated: new Date().toISOString() };
}

export function getSessionsDir(agentName: string): string {
  const dir = join(FLEET_DIR, "sessions", agentName);
  ensureDir(dir);
  return dir;
}

export function getFleetDir(): string {
  const dir = resolveFleetDir();
  ensureDir(dir);
  return dir;
}

// ─── Persistent Task Log (JSONL) ───

const TASK_LOG_FILE = join(FLEET_DIR, "task-log.jsonl");
const MAX_TASK_LOG_BYTES = 2 * 1024 * 1024; // 2 MB — auto-rotate

function getTaskLogFile(): string {
  return _testDir ? join(_testDir, "task-log.jsonl") : TASK_LOG_FILE;
}

export interface TaskLogEntry {
  ts: string;
  event: "dispatched" | "completed" | "failed";
  taskId: string;
  agent: string;
  task?: string;
  from?: string;
  durationMs?: number;
  result?: string;
}

let _taskIdCounter = 0;

export function generateTaskId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  _taskIdCounter++;
  return `t-${date}-${rand}${_taskIdCounter}`;
}

export function appendTaskLog(entry: TaskLogEntry): void {
  const file = getTaskLogFile();
  ensureDir(resolveFleetDir());
  try {
    if (existsSync(file)) {
      const stat = statSync(file);
      if (stat.size > MAX_TASK_LOG_BYTES) {
        const rotated = file + `.${Date.now()}.bak`;
        renameSync(file, rotated);
        console.log(`[task-log] rotated → ${rotated}`);
      }
    }
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.warn(`[task-log] write failed: ${(err as Error).message}`);
  }
}

export function readTaskLog(limit = 50): TaskLogEntry[] {
  const file = getTaskLogFile();
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, "utf-8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    const recent = lines.slice(-limit * 2);
    const entries: TaskLogEntry[] = [];
    for (const line of recent) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

export function reconstructTaskLedger(limit = 50): Array<{
  taskId: string;
  assignedAt: string;
  agent: string;
  task: string;
  status: "dispatched" | "completed" | "failed";
  completedAt?: string;
  result?: string;
  durationMs?: number;
}> {
  const entries = readTaskLog(limit * 3);
  const tasks = new Map<string, {
    taskId: string;
    assignedAt: string;
    agent: string;
    task: string;
    status: "dispatched" | "completed" | "failed";
    completedAt?: string;
    result?: string;
    durationMs?: number;
  }>();

  for (const e of entries) {
    if (e.event === "dispatched") {
      tasks.set(e.taskId, {
        taskId: e.taskId,
        assignedAt: e.ts,
        agent: e.agent,
        task: e.task || "",
        status: "dispatched",
      });
    } else {
      const t = tasks.get(e.taskId);
      if (t) {
        t.status = e.event;
        t.completedAt = e.ts;
        t.result = e.result;
        t.durationMs = e.durationMs;
      }
    }
  }

  return [...tasks.values()].slice(-limit);
}

export function loadWorkspaces(): WorkspaceEntry[] {
  if (!existsSync(WORKSPACES_FILE)) return [];
  try {
    const raw = readFileSync(WORKSPACES_FILE, "utf-8");
    const parsed = parseYaml(raw);
    if (!parsed?.workspaces) return [];
    const ws = parsed.workspaces;
    if (Array.isArray(ws)) {
      return ws.map((w: { alias: string; path: string }) => ({
        alias: w.alias,
        path: w.path,
      }));
    }
    // Handle object format: { alias1: { path: "..." }, alias2: "/path" }
    return Object.entries(ws).map(([alias, val]) => ({
      alias,
      path: typeof val === "string" ? val : (val as { path: string }).path,
    }));
  } catch {
    return [];
  }
}

export function saveWorkspaces(workspaces: WorkspaceEntry[]): void {
  const content = stringifyYaml({ workspaces });
  writeFileSync(WORKSPACES_FILE, content);
}

export function addWorkspace(alias: string, path: string): string {
  if (!existsSync(path)) {
    return `Error: path "${path}" does not exist on disk`;
  }

  const workspaces = loadWorkspaces();
  const existing = workspaces.find((w) => w.alias === alias);
  if (existing) {
    existing.path = path;
    saveWorkspaces(workspaces);
    return `Workspace "${alias}" updated to ${path}`;
  }

  workspaces.push({ alias, path });
  saveWorkspaces(workspaces);
  return `Workspace "${alias}" added (${path})`;
}

export function removeWorkspace(alias: string): string {
  const workspaces = loadWorkspaces();
  const idx = workspaces.findIndex((w) => w.alias === alias);
  if (idx === -1) return `Workspace "${alias}" not found`;
  workspaces.splice(idx, 1);
  saveWorkspaces(workspaces);
  return `Workspace "${alias}" removed`;
}

export function readRecentHistory(agentName: string, maxMessages: number = 10): string {
  const dir = getSessionsDir(agentName);
  if (!existsSync(dir)) return "";

  // Find the most recent session file
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return "";
  }

  if (files.length === 0) return "";

  const lines: string[] = [];

  // Read from most recent session files until we have enough messages
  for (const file of files.slice(0, 3)) {
    try {
      const content = readFileSync(join(dir, file), "utf-8").trim();
      if (!content) continue;
      const sessionLines = content.split("\n").filter(Boolean);
      for (const line of sessionLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "user_message" || entry.type === "agent_message") {
            const role = entry.type === "user_message" ? "→" : "←";
            const sender = entry.sender || "user";
            const text = (entry.text || "").slice(0, 150);
            lines.push(`${role} [${sender}] ${text}`);
          }
        } catch { /* skip unparseable lines */ }
      }
    } catch { /* skip unreadable files */ }
    if (lines.length >= maxMessages) break;
  }

  if (lines.length === 0) return "";

  // Return last N messages, most recent last
  return lines.slice(-maxMessages).join("\n");
}

export function renameWorkspace(oldAlias: string, newAlias: string): string {
  if (!newAlias.trim()) return "Error: new alias cannot be empty";
  if (oldAlias === "dispatch") return "Error: cannot rename the dispatcher workspace";

  const workspaces = loadWorkspaces();
  const entry = workspaces.find((w) => w.alias === oldAlias);
  if (!entry) return `Workspace "${oldAlias}" not found`;
  if (workspaces.find((w) => w.alias === newAlias)) return `Workspace "${newAlias}" already exists`;

  entry.alias = newAlias;
  saveWorkspaces(workspaces);
  return `Workspace renamed: "${oldAlias}" → "${newAlias}"`;
}
