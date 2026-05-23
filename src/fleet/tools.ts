import type { FleetManager, WorkspaceEntry } from "./manager.js";
import type { MessageSender } from "./types.js";

const FLEET_MARKER_REGEX = /\[FLEET:(\w+):(.*?)\]/g;
const DISPATCHER_NAME = "_dispatcher";

type ToolPermission = "dispatcher" | "all";

interface ToolDef {
  permission: ToolPermission;
  execute: (args: Record<string, unknown>, agentName: string, fleet: FleetManager, workspaces: WorkspaceEntry[]) => Promise<string>;
}

const TOOLS: Record<string, ToolDef> = {
  fleet_send: {
    permission: "all",
    async execute(args, agentName, fleet) {
      const target = args.agent as string;
      const text = args.text as string;
      if (!target || !text) return "Error: fleet_send requires 'agent' and 'text'";
      if (target === agentName) return "Error: cannot send to yourself";
      if (!fleet.hasAgent(target)) return `Error: agent "${target}" not found`;

      // Fire-and-forget: queue the message, don't await reply (avoid deadlock)
      fleet.send(target, text, agentName).then((reply) => {
        // Reply routing handled by the manager's post-reply hook
        console.log(`[fleet-tools] ${agentName} → ${target}: delivered, got ${reply.length} char reply`);
      }).catch((err) => {
        console.warn(`[fleet-tools] ${agentName} → ${target}: send failed: ${(err as Error).message?.slice(0, 60)}`);
      });

      return `Message queued for @${target}`;
    },
  },

  fleet_status: {
    permission: "all",
    async execute(_args, _agentName, fleet, workspaces) {
      const status = fleet.getStatus();
      const agentLines = status.agents.map((a) =>
        `  @${a.name}: ${a.runtime} · ${a.workspace} · ${a.status}${a.sessionName ? ` 「${a.sessionName}」` : ""}`
      ).join("\n");
      const wsLines = workspaces.map((w) => `  ${w.alias}: ${w.path}`).join("\n");
      return `Fleet: ${status.total} agents (${status.working} working, ${status.idle} idle, ${status.dead} dead)\n${agentLines}\n\nWorkspaces:\n${wsLines}`;
    },
  },

  fleet_spawn: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const name = args.name as string;
      const runtime = args.runtime as string;
      const workspace = args.workspace as string;
      if (!name || !runtime || !workspace) return "Error: fleet_spawn requires 'name', 'runtime', 'workspace'";
      const result = await fleet.spawn(name, runtime as "cursor" | "claude-code" | "codex", workspace);
      return result;
    },
  },

  fleet_kill: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const name = args.name as string;
      if (!name) return "Error: fleet_kill requires 'name'";
      const result = await fleet.kill(name);
      return result;
    },
  },

  fleet_clear: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const name = args.name as string;
      if (!name) return "Error: fleet_clear requires 'name'";
      const result = await fleet.clear(name);
      return result;
    },
  },

  fleet_workspace_add: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const alias = args.alias as string;
      const path = args.path as string;
      if (!alias || !path) return "Error: fleet_workspace_add requires 'alias' and 'path'";
      const result = fleet.addWorkspace(alias, path);
      return result;
    },
  },

  fleet_workspace_list: {
    permission: "dispatcher",
    async execute(_args, _agentName, fleet, workspaces) {
      const lines = workspaces.map((w) => `  ${w.alias}: ${w.path}`).join("\n");
      return `Workspaces:\n${lines}`;
    },
  },
};

export function createPostReplyHook(
  fleet: FleetManager,
  workspaces: WorkspaceEntry[],
) {
  return async (agentName: string, reply: string, _sender: MessageSender): Promise<string> => {
    const matches = [...reply.matchAll(FLEET_MARKER_REGEX)];
    if (matches.length === 0) return reply;

    const isDispatcher = agentName === DISPATCHER_NAME;
    const results: string[] = [];

    for (const match of matches) {
      const [fullMatch, action, argsJson] = match;
      const tool = TOOLS[action];

      if (!tool) {
        results.push(`[FLEET-RESULT:${action}:unknown tool]`);
        continue;
      }

      if (tool.permission === "dispatcher" && !isDispatcher) {
        results.push(`[FLEET-RESULT:${action}:permission denied — only dispatcher can use ${action}]`);
        console.log(`[fleet-tools] ${agentName} tried ${action} but lacks permission`);
        continue;
      }

      try {
        const args = JSON.parse(argsJson);
        const result = await tool.execute(args, agentName, fleet, workspaces);
        results.push(`[FLEET-RESULT:${action}:${result}]`);
        console.log(`[fleet-tools] ${agentName} called ${action}: ${result.slice(0, 80)}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.push(`[FLEET-RESULT:${action}:error — ${errMsg.slice(0, 80)}]`);
      }
    }

    // Strip markers from visible reply, append results as a log note
    const cleanReply = reply.replace(FLEET_MARKER_REGEX, "").trim();
    // Log fleet tool results to session (but don't show them to user in Telegram)
    if (results.length > 0) {
      console.log(`[fleet-tools] ${agentName}: ${results.length} tool call(s) executed`);
    }

    return cleanReply;
  };
}

export { getToolInstructions } from "./tool-instructions.js";
