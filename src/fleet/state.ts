import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FleetState } from "./types.js";
import type { WorkspaceEntry } from "./manager.js";

const KENYALANG_HOME = process.env.KENYALANG_HOME || join(homedir(), ".kenyalang");
const FLEET_DIR = join(KENYALANG_HOME, "fleet");
const STATE_FILE = join(FLEET_DIR, "fleet-state.json");
const WORKSPACES_FILE = join(KENYALANG_HOME, "workspaces.yaml");

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
    if (!parsed?.workspaces || !Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces.map((w: { alias: string; path: string }) => ({
      alias: w.alias,
      path: w.path,
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
