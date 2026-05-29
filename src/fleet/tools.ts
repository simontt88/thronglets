import type { FleetManager } from "./manager.js";
import type { MessageSender, WorkspaceEntry } from "./types.js";
import type { CommsMode } from "../config.js";
import { DISPATCHER_NAME } from "../utils/constants.js";

const TOOL_CALLS_BLOCK_REGEX = /<TOOL_CALLS>\s*([\s\S]*?)\s*<\/TOOL_CALLS>/g;
const LEGACY_FLEET_MARKER_REGEX = /\[FLEET:(\w+):(\{[\s\S]*?\})\]/g;
const DISPATCH_CLAIM_REGEX = /(派给|派发|分配给|让\s*@?[\w一-龥]+\s*(?:写|做|实现|执行|完成|去|来|准备|继续|开始|处理|跟进)|let\s+@?\w+\s+(?:write|do|implement|handle|continue|start)|assigned to @?\w+|dispatched to @?\w+|hand(?:ed|ing) off to @?\w+)/i;

interface ParsedToolCall {
  tool: string;
  args: Record<string, unknown>;
}

interface ParsedReply {
  narrative: string;
  structuredCalls: ParsedToolCall[];
  legacyCalls: ParsedToolCall[];
  blockParseError?: string;
}

export function parseReplyToolCalls(reply: string): ParsedReply {
  const result: ParsedReply = { narrative: reply, structuredCalls: [], legacyCalls: [] };

  for (const m of reply.matchAll(TOOL_CALLS_BLOCK_REGEX)) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) throw new Error("TOOL_CALLS block must be a JSON array");
      for (const entry of arr) {
        if (!entry || typeof entry !== "object" || typeof (entry as { tool?: unknown }).tool !== "string") {
          throw new Error(`invalid tool call entry: ${JSON.stringify(entry).slice(0, 80)}`);
        }
        const e = entry as { tool: string; args?: Record<string, unknown> };
        result.structuredCalls.push({ tool: e.tool, args: e.args ?? {} });
      }
    } catch (err) {
      result.blockParseError = err instanceof Error ? err.message : String(err);
    }
  }
  result.narrative = result.narrative.replace(TOOL_CALLS_BLOCK_REGEX, "").trim();

  for (const m of result.narrative.matchAll(LEGACY_FLEET_MARKER_REGEX)) {
    try {
      const args = JSON.parse(m[2]);
      result.legacyCalls.push({ tool: m[1], args });
    } catch {
      // malformed legacy marker — skip silently (the parse-error path is for the structured block)
    }
  }
  result.narrative = result.narrative.replace(LEGACY_FLEET_MARKER_REGEX, "").trim();

  return result;
}

export function detectDispatchClaim(narrative: string): boolean {
  return DISPATCH_CLAIM_REGEX.test(narrative);
}

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
    const parsed = parseReplyToolCalls(reply);
    const isDispatcher = agentName === DISPATCHER_NAME;

    if (parsed.blockParseError) {
      console.warn(`[fleet-tools] ${agentName}: <TOOL_CALLS> block malformed — ${parsed.blockParseError}`);
      fleet.emitFleetActivity("tool_block_parse_error", agentName, { error: parsed.blockParseError });
    }

    const allCalls = [...parsed.structuredCalls, ...parsed.legacyCalls];
    if (allCalls.length === 0 && !parsed.blockParseError) {
      // No tool calls at all — fast path. Still run dispatch-claim self-check below.
    }

    for (const call of allCalls) {
      const tool = TOOLS[call.tool];
      if (!tool) {
        console.log(`[fleet-tools] ${agentName} called unknown tool: ${call.tool}`);
        continue;
      }
      if (tool.permission === "dispatcher" && !isDispatcher) {
        console.log(`[fleet-tools] ${agentName} tried ${call.tool} but lacks permission`);
        continue;
      }
      try {
        const result = await tool.execute(call.args, agentName, fleet, workspaces, commsMode);
        console.log(`[fleet-tools] ${agentName} called ${call.tool}: ${result.slice(0, 80)}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[fleet-tools] ${agentName} ${call.tool} FAILED: ${errMsg.slice(0, 120)}`);
      }
    }

    if (allCalls.length > 0) {
      console.log(`[fleet-tools] ${agentName}: ${allCalls.length} tool call(s) (${parsed.structuredCalls.length} structured, ${parsed.legacyCalls.length} legacy)`);
    }

    // Self-validation: narrate-but-not-emit
    const claimedDispatch = detectDispatchClaim(parsed.narrative);
    const emittedDispatch = allCalls.some((c) => c.tool === "fleet_send" || c.tool === "fleet_spawn");
    if (claimedDispatch && !emittedDispatch) {
      console.warn(`[fleet-tools] ${agentName}: NARRATE-WITHOUT-EMIT — claimed dispatch in narrative but emitted no fleet_send/fleet_spawn`);
      fleet.emitFleetActivity("narrate_without_emit", agentName, {
        narrative_excerpt: parsed.narrative.slice(0, 240),
      });
    }

    return parsed.narrative;
  };
}

const STRUCTURED_PROTOCOL = `
## Fleet tools — structured emission protocol

When you want to take an action (send a message to another agent, set the fleet goal, notify the user, etc.), emit it as a **trailing JSON block** at the END of your reply:

\`\`\`
<your narrative reply to the user/dispatcher — free text, markdown, anything>

<TOOL_CALLS>
[
  { "tool": "fleet_send", "args": { "agent": "Hivka", "text": "Please draft the positioning doc" } }
]
</TOOL_CALLS>
\`\`\`

Hard rules:
- The block MUST be at the END of your reply (after all narrative).
- The block MUST be a valid JSON array. Each entry: { "tool": "<name>", "args": { ... } }.
- Use ONE block per reply. Multiple tool calls go inside the same array.
- If you have nothing to dispatch, omit the block entirely.
- **NEVER narrate "I sent X to Y" / "让 @X 处理" without actually emitting a fleet_send tool call** — the bridge logs a NARRATE-WITHOUT-EMIT warning when it detects this and the dispatch did not happen.`;

function toolListBlock(tools: Array<[string, string]>): string {
  return "Available tools:\n" + tools.map(([n, sig]) => `- \`${n}\`  ${sig}`).join("\n");
}

export function getToolInstructions(isDispatcher: boolean, commsMode: CommsMode = "hive"): string {
  let toolList: string;
  let mode: string;

  if (isDispatcher) {
    mode = "dispatcher mode — full control";
    toolList = toolListBlock([
      ["fleet_send",          `{ "agent": string, "text": string, "files"?: string[] } — send a message to another agent`],
      ["fleet_spawn",         `{ "runtime": "cursor", "workspace": string }  — hatch a new agent (name auto-assigned, do NOT pick one)`],
      ["fleet_kill",          `{ "name": string }                            — kill an agent (avoid; prefer fleet_clear)`],
      ["fleet_clear",         `{ "name": string }                            — reset an agent's session (preserves identity)`],
      ["fleet_status",        `{}                                            — get fleet status`],
      ["fleet_workspace_add", `{ "alias": string, "path": string }           — register a workspace`],
      ["fleet_workspace_list",`{}`],
      ["fleet_set_title",     `{ "name": string, "title": string }           — set a throng's role label`],
      ["fleet_set_goal",      `{ "goal": string }                            — set the fleet's standing goal`],
      ["fleet_send_media",    `{ "type": "photo"|"document", "path": string, "caption"?: string }  — share an image/file with the user`],
      ["fleet_notify_user",   `{ "text": string, "level": "info"|"critical" } — push a visible message to the user (your replies to system messages are silent by default)`],
      ["fleet_task_log",      `{ "limit"?: number }                          — review recent task outcomes before dispatching`],
    ]);
  } else if (commsMode === "leash") {
    mode = "leash mode — status only, no agent-to-agent comms";
    toolList = toolListBlock([
      ["fleet_status", `{}`],
    ]);
  } else if (commsMode === "hive") {
    mode = "hive mode — only the dispatcher is a valid send target";
    toolList = toolListBlock([
      ["fleet_send",       `{ "agent": "_dispatcher", "text": string, "files"?: string[] }  — only "_dispatcher" is valid`],
      ["fleet_status",     `{}`],
      ["fleet_send_media", `{ "type": "photo"|"document", "path": string, "caption"?: string }`],
    ]);
  } else {
    mode = "swarm mode — send messages to any agent";
    toolList = toolListBlock([
      ["fleet_send",       `{ "agent": string, "text": string, "files"?: string[] }`],
      ["fleet_status",     `{}`],
      ["fleet_send_media", `{ "type": "photo"|"document", "path": string, "caption"?: string }`],
    ]);
  }

  return `${STRUCTURED_PROTOCOL}

### ${mode}

${toolList}
`;
}
