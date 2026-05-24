import type { AgentState, WorkspaceEntry } from "./types.js";
import type { CommsMode } from "../config.js";
import { getToolInstructions } from "./tools.js";
import { DISPATCHER_NAME } from "../utils/constants.js";

interface FleetSnapshot {
  agents: AgentState[];
  total: number;
  working: number;
  waiting: number;
  sleeping: number;
  dead: number;
}

export function buildAgentPreamble(name: string, state: AgentState, sessionsDir: string, commsMode: CommsMode = "hive"): string {
  const titleStr = state.title ? ` — ${state.title}` : "";
  const personality = state.personality || "curious";

  const autoReport = commsMode !== "leash"
    ? [
        ``,
        `## Task completion protocol`,
        `When you finish a task (or hit a blocker), send a brief status report to the dispatcher:`,
        `  [FLEET:fleet_send:{"agent":"${DISPATCHER_NAME}","text":"DONE: <1-line summary>. Output: <key file paths>"}]`,
        `If you created or modified files that another throng may need, include the absolute paths in your report.`,
        `This lets the dispatcher chain follow-up tasks without asking you for status.`,
      ]
    : [];

  return [
    `[SYSTEM] Your name is "${name}"${titleStr}. You ARE ${name}. Never refer to yourself in third person — you are the one doing the work, not delegating to yourself.`,
    `Personality: ${personality}.`,
    `You are a throng (coding agent) in the Thronglets fleet. Your session logs: ${sessionsDir}`,
    `Messages from other agents are prefixed [from:name]. Messages from the dispatcher are [from:_dispatcher]. Messages from the human master have no prefix.`,
    "",
    getToolInstructions(false, commsMode),
    ...autoReport,
  ].join("\n");
}

export function buildDispatcherPreamble(
  status: FleetSnapshot,
  workspaces: WorkspaceEntry[],
  sessionsDir: string,
  goal?: string,
): string {
  const agentSummary = status.agents
    .filter((a) => a.name !== DISPATCHER_NAME)
    .map((a) => {
      const titlePart = a.title ? ` [${a.title}]` : "";
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
    `- **Match by workspace first**: each workspace is a codebase — route to the throng whose workspace matches the task's project.`,
    `- **Then by title/role**: if a throng has a title (shown as [title] in fleet list), it indicates specialization — prefer it for matching tasks.`,
    `- **Then by status**: prefer "waiting" throngs over "working" ones. Never interrupt a working throng unless urgent.`,
    `- Split large tasks across throngs when they span different workspaces.`,
    `- Never do coding work yourself — always delegate.`,
    `- If no throngs available for a workspace, suggest hatching one.`,
    `- When spawning: NEVER specify a name. Names are auto-assigned by the system.`,
    `- When a throng reports "DONE: ...", acknowledge it and chain the next step if the goal requires it.`,
    `- If a throng reports file paths, forward those paths to the next throng that needs them.`,
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
