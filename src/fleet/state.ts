import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { FleetState } from "./types.js";

const FLEET_DIR = join(homedir(), ".kenyalang", "fleet");
const STATE_FILE = join(FLEET_DIR, "fleet-state.json");

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
