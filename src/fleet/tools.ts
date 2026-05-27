import type { FleetManager } from "./manager.js";
import type { MessageSender, WorkspaceEntry } from "./types.js";
import type { CommsMode } from "../config.js";
import { DISPATCHER_NAME } from "../utils/constants.js";

const FLEET_MARKER_REGEX = /\[FLEET:(\w+):(\{[\s\S]*?\})\]/g;

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
      const files = args.files as string[] | undefined;
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

      let fullText = text;
      if (files && files.length > 0) {
        fullText += `\n\n📎 Files: ${files.join(", ")}`;
      }

      fleet.send(target, fullText, agentName).then((reply) => {
        console.log(`[fleet-tools] ${agentName} → ${target}: delivered, got ${reply.length} char reply`);
        fleet.emitFleetActivity("send_success", target, { from: agentName, task: text.slice(0, 80) });
      }).catch((err) => {
        const errMsg = (err as Error).message?.slice(0, 60) || "unknown";
        console.warn(`[fleet-tools] ${agentName} → ${target}: send failed: ${errMsg}`);
        fleet.emitFleetActivity("send_failed", target, { from: agentName, error: errMsg });
      });

      return `Message queued for @${target}`;
    },
  },

  fleet_status: {
    permission: "all",
    async execute(_args, _agentName, fleet, workspaces) {
      const status = fleet.getStatus();
      const formatAge = (iso: string | undefined): string => {
        if (!iso) return "";
        const ms = Date.now() - new Date(iso).getTime();
        if (ms < 60_000) return "just now";
        if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
        return `${Math.round(ms / 3600_000)}h ago`;
      };
      const agentLines = status.agents.map((a) => {
        const parts = [`  @${a.name}${a.title ? ` (${a.title})` : ""}: ${a.runtime} · ${a.workspace} · ${a.status}`];
        if (a.sessionName) parts.push(`「${a.sessionName}」`);
        if (a.lastUserMessage) {
          const age = formatAge(a.lastUserMessageAt);
          const preview = a.lastUserMessage.length > 60 ? a.lastUserMessage.slice(0, 60) + "…" : a.lastUserMessage;
          parts.push(`📩 user direct${age ? ` (${age})` : ""}: "${preview}"`);
        }
        return parts.join(" ");
      }).join("\n");
      const wsLines = workspaces.map((w) => `  ${w.alias}: ${w.path}`).join("\n");
      return `Fleet: ${status.total} agents (${status.working} working, ${status.waiting} waiting, ${status.sleeping} sleeping, ${status.dead} dead)\n${agentLines}\n\nWorkspaces:\n${wsLines}`;
    },
  },

  fleet_spawn: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const runtime = (args.runtime as string) || "cursor";
      const workspace = args.workspace as string;
      if (!workspace) return "Error: fleet_spawn requires 'runtime' and 'workspace'";
      const result = await fleet.spawn(undefined, runtime as "cursor", workspace);
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

  fleet_send_media: {
    permission: "all",
    async execute(args, agentName, fleet) {
      const type = (args.type as string) || "photo";
      const path = args.path as string;
      const caption = (args.caption as string) || "";
      if (!path) return "Error: fleet_send_media requires 'path'";
      if (type !== "photo" && type !== "document") return "Error: type must be 'photo' or 'document'";
      fleet.queueOutgoingMedia(agentName, { type: type as "photo" | "document", source: path, caption });
      return `Media queued: ${type} from ${path}`;
    },
  },

  fleet_notify_user: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const text = args.text as string;
      const level = (args.level as string) || "info";
      if (!text) return "Error: fleet_notify_user requires 'text'";
      fleet.emitUserNotification(text, level);
      return `Notification sent to user (${level})`;
    },
  },

  fleet_task_log: {
    permission: "dispatcher",
    async execute(args, _agentName, fleet) {
      const limit = (args.limit as number) || 20;
      return fleet.getRecentTaskLog(limit);
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
        console.warn(`[fleet-tools] ${agentName} ${action} FAILED: ${errMsg.slice(0, 120)} | args: ${argsJson.slice(0, 100)}`);
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
- Send with file paths: [FLEET:fleet_send:{"agent":"name","text":"message","files":["/abs/path/file.ts"]}]
- Spawn new agent: [FLEET:fleet_spawn:{"runtime":"cursor","workspace":"alias"}]  (name is auto-assigned — do NOT pick a name)
- Kill agent: [FLEET:fleet_kill:{"name":"agentname"}]
- Clear agent session: [FLEET:fleet_clear:{"name":"agentname"}]
- Get fleet status: [FLEET:fleet_status:{}]
- Add workspace: [FLEET:fleet_workspace_add:{"alias":"short-name","path":"/absolute/path"}]
- List workspaces: [FLEET:fleet_workspace_list:{}]
- Set agent title: [FLEET:fleet_set_title:{"name":"agentname","title":"QA master"}]
- Set fleet goal: [FLEET:fleet_set_goal:{"goal":"Build and test the auth module"}]
- Send media to user: [FLEET:fleet_send_media:{"type":"photo","path":"/abs/path/image.png","caption":"optional caption"}]
  Types: "photo" (images), "document" (files). Path must be an absolute filesystem path.
- Notify user on Telegram: [FLEET:fleet_notify_user:{"text":"message","level":"info"}]
  Use this to escalate something to the user. Your replies to system messages are silent by default.
  Levels: "critical" (always delivered), "info" (throttled, for progress updates)
- View task log: [FLEET:fleet_task_log:{"limit":20}]
  See recent task dispatches and their outcomes (completed/failed/pending).

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
- Send with file paths: [FLEET:fleet_send:{"agent":"_dispatcher","text":"message","files":["/abs/path/file.ts"]}]
- Get fleet status: [FLEET:fleet_status:{}]
- Send media to user: [FLEET:fleet_send_media:{"type":"photo","path":"/abs/path/image.png","caption":"optional caption"}]
  Types: "photo" (images), "document" (files). Path must be an absolute filesystem path.

When reporting task completion, include any file paths the dispatcher might forward to other throngs.
You CANNOT send messages to other agents — route through the dispatcher.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
  }

  return `
## Fleet Tools (swarm mode — send messages to any agent)

You can communicate with other agents by including markers in your reply:

- Send message to another agent: [FLEET:fleet_send:{"agent":"name","text":"message"}]
- Send with file paths: [FLEET:fleet_send:{"agent":"name","text":"message","files":["/abs/path/file.ts"]}]
- Get fleet status: [FLEET:fleet_status:{}]
- Send media to user: [FLEET:fleet_send_media:{"type":"photo","path":"/abs/path/image.png","caption":"optional caption"}]
  Types: "photo" (images), "document" (files). Path must be an absolute filesystem path.

Use the "files" field to share file paths when collaborating across workspaces.
The message will be queued and the other agent will see it tagged with your name.
You CANNOT spawn, kill, or clear other agents — only the dispatcher can.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
}
