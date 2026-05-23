import type { AgentState, WorkspaceEntry } from "./types.js";
import { getToolInstructions } from "./tools.js";

interface FleetSnapshot {
  agents: AgentState[];
  total: number;
  working: number;
  waiting: number;
  sleeping: number;
  dead: number;
}

export function buildAgentPreamble(name: string, state: AgentState, sessionsDir: string): string {
  const titleStr = state.title ? ` — ${state.title}` : "";
  const personality = state.personality || "curious";
  return [
    `[SYSTEM] Your name is "${name}"${titleStr}. You ARE ${name}. Never refer to yourself in third person — you are the one doing the work, not delegating to yourself.`,
    `Personality: ${personality}.`,
    `You are a throng (coding agent) in the Thronglets fleet. Your session logs: ${sessionsDir}`,
    `Messages from other agents are prefixed [from:name]. Messages from the dispatcher are [from:_dispatcher]. Messages from the human master have no prefix.`,
    "",
    getToolInstructions(false),
  ].join("\n");
}

export function buildDispatcherPreamble(
  status: FleetSnapshot,
  workspaces: WorkspaceEntry[],
  sessionsDir: string,
  goal?: string,
): string {
  const agentSummary = status.agents
    .filter((a) => a.name !== "_dispatcher")
    .map((a) => {
      const titlePart = a.title ? ` (${a.title})` : "";
      const parts = [`@${a.name}${titlePart}: ${a.runtime} · ws:${a.workspace} · ${a.status}`];
      if (a.sessionName) parts.push(`「${a.sessionName}」`);
      if (a.inferred && a.status === "working") parts.push(`(${a.inferred})`);
      return `  - ${parts.join(" ")}`;
    })
    .join("\n");

  const wsSummary = workspaces
    .map((w) => `  - ${w.alias}: ${w.path}`)
    .join("\n");

  return [
    `[SYSTEM] You are the Thronglets Fleet Dispatcher (Orix).`,
    `Your session logs: ${sessionsDir}`,
    ``,
    `## Your role`,
    `You manage a fleet of throngs (coding agents). Each runs in a specific workspace.`,
    `When the user sends a message:`,
    `1. Analyze what they need`,
    `2. Route to the best throng(s) by workspace match`,
    `3. Forward using fleet tools below`,
    `4. Report back briefly`,
    ``,
    `## Routing rules`,
    `- Match by workspace first, then split large tasks across throngs.`,
    `- Never do coding work yourself — always delegate.`,
    `- If no throngs available, suggest hatching one.`,
    ``,
    getToolInstructions(true),
    ``,
    `## Current fleet`,
    `${status.total - 1} throngs (${status.working} working, ${status.waiting} waiting, ${status.sleeping} sleeping, ${status.dead} dead)`,
    agentSummary || "  (no throngs hatched — suggest hatching one)",
    ``,
    `## Workspaces`,
    wsSummary || "  (none configured)",
    ``,
    goal
      ? `## Current goal\n${goal}\n\nUse this goal to guide your routing decisions. When poked, autonomously assign tasks to idle agents based on this goal and recent progress.`
      : `## No goal set\nOn your FIRST reply to the user, briefly ask what the fleet should focus on. Once they tell you, persist it with fleet_set_goal. Example: "What should the fleet focus on? I'll coordinate once I know the goal."`,
  ].join("\n");
}
