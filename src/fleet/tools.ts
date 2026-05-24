import type { FleetManager } from "./manager.js";
import type { MessageSender, WorkspaceEntry } from "./types.js";
import type { CommsMode } from "../config.js";

const FLEET_MARKER_REGEX = /\[FLEET:(\w+):(.*?)\]/g;
const DISPATCHER_NAME = "_dispatcher";

type ToolPermission = "dispatcher" | "all";

interface ToolDef {
  permission: ToolPermission;
  execute: (args: Record<string, unknown>, agentName: string, fleet: FleetManager, workspaces: WorkspaceEntry[], commsMode: CommsMode) => Promise<string>;
}

const TOOLS: Record<string, ToolDef> = {
  fleet_send: {
    permission: "all",
    async execute(args, agentName, fleet, _workspaces, commsMode) {
      const target = args.agent as string;
      const text = args.text as string;
      if (!target || !text) return "Error: fleet_send requires 'agent' and 'text'";
      if (target === agentName) return "Error: cannot send to yourself";
      if (!fleet.hasAgent(target)) return `Error: agent "${target}" not found`;

      const isDispatcher = agentName === DISPATCHER_NAME;
      const targetIsDispatcher = target === DISPATCHER_NAME;

      if (commsMode === "leash" && !isDispatcher) {
        return "Error: fleet_send disabled — comms mode is 'leash'. Only the dispatcher can send messages.";
      }
      if (commsMode === "hive" && !isDispatcher && !targetIsDispatcher) {
        return `Error: cannot send to @${target} — comms mode is 'hive'. You can only report to the dispatcher.`;
      }

      fleet.send(target, text, agentName).then((reply) => {
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
        `  @${a.name}${a.title ? ` (${a.title})` : ""}: ${a.runtime} · ${a.workspace} · ${a.status}${a.sessionName ? ` 「${a.sessionName}」` : ""}`
      ).join("\n");
      const wsLines = workspaces.map((w) => `  ${w.alias}: ${w.path}`).join("\n");
      return `Fleet: ${status.total} agents (${status.working} working, ${status.waiting} waiting, ${status.sleeping} sleeping, ${status.dead} dead)\n${agentLines}\n\nWorkspaces:\n${wsLines}`;
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

  fleet_set_title: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const name = args.name as string;
      const title = args.title as string;
      if (!name || !title) return "Error: fleet_set_title requires 'name' and 'title'";
      const result = fleet.setTitle(name, title);
      return result;
    },
  },

  fleet_set_goal: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const goal = args.goal as string;
      if (!goal) return "Error: fleet_set_goal requires 'goal'";
      fleet.setGoal(goal);
      return `Goal set: ${goal.slice(0, 200)}`;
    },
  },
};

export function createPostReplyHook(
  fleet: FleetManager,
  workspaces: WorkspaceEntry[],
  commsMode: CommsMode,
) {
  return async (agentName: string, reply: string, _sender: MessageSender): Promise<string> => {
    const matches = [...reply.matchAll(FLEET_MARKER_REGEX)];
    if (matches.length === 0) return reply;

    const isDispatcher = agentName === DISPATCHER_NAME;
    const results: string[] = [];

    for (const match of matches) {
      const [_fullMatch, action, argsJson] = match;
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
        const result = await tool.execute(args, agentName, fleet, workspaces, commsMode);
        results.push(`[FLEET-RESULT:${action}:${result}]`);
        console.log(`[fleet-tools] ${agentName} called ${action}: ${result.slice(0, 80)}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.push(`[FLEET-RESULT:${action}:error — ${errMsg.slice(0, 80)}]`);
      }
    }

    const cleanReply = reply.replace(FLEET_MARKER_REGEX, "").trim();
    if (results.length > 0) {
      console.log(`[fleet-tools] ${agentName}: ${results.length} tool call(s) executed`);
    }

    return cleanReply;
  };
}

export function getToolInstructions(isDispatcher: boolean, commsMode: CommsMode = "hive"): string {
  if (isDispatcher) {
    return `
## Fleet Tools (you are the dispatcher — full control)

You can execute fleet operations by including markers in your reply:

- Send message to agent: [FLEET:fleet_send:{"agent":"name","text":"message"}]
- Spawn new agent: [FLEET:fleet_spawn:{"name":"agentname","runtime":"cursor","workspace":"alias"}]
- Kill agent: [FLEET:fleet_kill:{"name":"agentname"}]
- Clear agent session: [FLEET:fleet_clear:{"name":"agentname"}]
- Get fleet status: [FLEET:fleet_status:{}]
- Add workspace: [FLEET:fleet_workspace_add:{"alias":"short-name","path":"/absolute/path"}]
- List workspaces: [FLEET:fleet_workspace_list:{}]
- Set agent title: [FLEET:fleet_set_title:{"name":"agentname","title":"QA master"}]
- Set fleet goal: [FLEET:fleet_set_goal:{"goal":"Build and test the auth module"}]

You can include multiple markers in one reply. Results are logged to your session.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
  }

  if (commsMode === "leash") {
    return `
## Fleet Tools (leash mode — status only)

You can check fleet status but CANNOT send messages to other agents.
All communication goes through the human. Focus on your assigned task.

- Get fleet status: [FLEET:fleet_status:{}]
`;
  }

  if (commsMode === "hive") {
    return `
## Fleet Tools (hive mode — dispatcher comms only)

You can communicate with the dispatcher only (not other agents directly):

- Send message to dispatcher: [FLEET:fleet_send:{"agent":"_dispatcher","text":"message"}]
- Get fleet status: [FLEET:fleet_status:{}]

You CANNOT send messages to other agents — route through the dispatcher.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
  }

  return `
## Fleet Tools (swarm mode — send messages to any agent)

You can communicate with other agents by including markers in your reply:

- Send message to another agent: [FLEET:fleet_send:{"agent":"name","text":"message"}]
- Get fleet status: [FLEET:fleet_status:{}]

The message will be queued and the other agent will see it tagged with your name.
You CANNOT spawn, kill, or clear other agents — only the dispatcher can.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
}
