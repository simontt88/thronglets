import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FleetState, WorkspaceEntry } from "./types.js";
import { GLOBAL_CONFIG_DIR } from "../config.js";

const THRONGLETS_HOME = GLOBAL_CONFIG_DIR;
const FLEET_DIR = join(THRONGLETS_HOME, "fleet");
const STATE_FILE = join(FLEET_DIR, "fleet-state.json");
const WORKSPACES_FILE = join(THRONGLETS_HOME, "workspaces.yaml");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadFleetState(): FleetState {
  ensureDir(FLEET_DIR);
  if (!existsSync(STATE_FILE)) {
    return { agents: {}, version: 1, lastUpdated: new Date().toISOString() };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as FleetState;
  } catch {
    return { agents: {}, version: 1, lastUpdated: new Date().toISOString() };
  }
}

export function saveFleetState(state: FleetState): void {
  ensureDir(FLEET_DIR);
  state.lastUpdated = new Date().toISOString();
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

export function getSessionsDir(agentName: string): string {
  const dir = join(FLEET_DIR, "sessions", agentName);
  ensureDir(dir);
  return dir;
}

export function getFleetDir(): string {
  ensureDir(FLEET_DIR);
  return FLEET_DIR;
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
