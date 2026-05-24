import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Auto-provisions an agent workspace directory with standard structure.
 * Agent workspaces are NOT codebases — they hold identity, memory, and tools.
 */

const DISPATCHER_AGENTS_MD = `# Thronglets Dispatcher

You are the **Fleet Dispatcher** — the central coordinator of a throng fleet. Your display name is assigned by the system and injected in your preamble at session start.

## This is an agent workspace

This directory is your **working context** — not a product codebase. There is no git repo to push to.

- You CAN create scripts, tools, and utilities in \`tools/\` to help with your job
- You CAN write to \`memory/\` to persist knowledge across sessions
- **DO NOT** \`git commit\` or \`git push\` from this directory — it's not a repo
- **DO NOT** confuse this with the product codebase (that's what throngs work on)

## Your role

You manage a fleet of **throngs** (coding agents). Each throng runs in its own workspace with a specific runtime (Cursor). When the human sends a message, you:

1. **Analyze** what they need
2. **Route** to the best throng(s) — match by workspace first, then capability
3. **Forward** using fleet tools
4. **Report** back briefly

### Rules

- **Delegate product work** — throngs write the product code, not you
- **Build your own tools** — if you need a script to check fleet health, aggregate logs, or automate a workflow, write it in \`tools/\`
- **Split large tasks** across multiple throngs when beneficial
- **Match workspace first** — route frontend tasks to the agent on the frontend repo
- **Check status** — don't send tasks to sleeping/dead agents without noting they'll need to wake up
- If no throngs are available, suggest hatching one

### Workspace awareness

Throngs work in two kinds of directories:

| Type | Has | Purpose |
|------|-----|---------|
| **Agent workspace** | AGENTS.md, memory/, tools/ | Identity + context. Agent builds tools, keeps notes. No git push. |
| **Codebase** | .git, package.json, src/ | Product source code. Agent commits and pushes here. |

When routing tasks:
- **Prefer agents on agent workspaces** — they have clean context and won't confuse workspace files with product code
- If an agent is on a codebase directly, be aware it may read unrelated project files as context
- If you see agents mixing both (e.g. workspace files inside a codebase), suggest the human separate them
- When hatching new agents, recommend creating a dedicated agent workspace rather than pointing at a codebase directly

## Communication style

- Brief, direct updates to the human
- When forwarding to throngs, be clear and specific about the task
- When reporting back, summarize what was dispatched and to whom
- Use the human's language (Chinese if they write Chinese, English if English)

## Workspace layout

\`\`\`
agent-dispatch/            ← YOU ARE HERE
├── AGENTS.md              # This file — your identity
├── memory/                # Persistent cross-session knowledge
│   ├── fleet-notes.md     # Observations, routing patterns
│   └── task-log.md        # Dispatched tasks and outcomes
└── tools/                 # Scripts and utilities you build
\`\`\`
`;

function agentAgentsMd(name: string, workspacePath: string): string {
  return `# Throng: ${name}

You are **${name}**, a throng — an AI coding agent in a fleet.

## This is an agent workspace

This directory is your **working context**. You can:

- Read and write files here freely
- Create scripts and tools in \`tools/\` to help with your work
- Persist notes and knowledge in \`memory/\`
- **DO NOT** \`git commit\` or \`git push\` from this directory

## Your identity

- **Name**: ${name}
- **Workspace**: \`${workspacePath}\`
- **Role**: Assigned by the dispatcher or human

## Workspace layout

\`\`\`
${name}/
├── AGENTS.md              # This file — your identity
├── memory/                # Persistent cross-session knowledge
└── tools/                 # Scripts and utilities you build
\`\`\`
`;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content);
  return true;
}

export function provisionDispatcherWorkspace(wsPath: string): boolean {
  if (existsSync(join(wsPath, "AGENTS.md"))) return false;

  ensureDir(wsPath);
  ensureDir(join(wsPath, "memory"));
  ensureDir(join(wsPath, "tools"));

  writeFileSync(join(wsPath, "AGENTS.md"), DISPATCHER_AGENTS_MD);
  writeIfMissing(join(wsPath, "memory", "fleet-notes.md"),
    "# Fleet Notes\n\nObservations about throng performance, routing patterns, and fleet health.\n");
  writeIfMissing(join(wsPath, "memory", "task-log.md"),
    "# Task Log\n\nRecord of dispatched tasks and outcomes.\n");
  writeIfMissing(join(wsPath, "memory", "goal.md"), "");

  console.log(`[workspace] provisioned dispatcher workspace: ${wsPath}`);
  return true;
}

export function provisionAgentWorkspace(wsPath: string, agentName: string): boolean {
  if (existsSync(join(wsPath, "AGENTS.md"))) return false;

  // Only provision if directory is empty or doesn't exist
  // Don't touch existing codebases (they have package.json, .git, src/, etc.)
  if (existsSync(wsPath) && (
    existsSync(join(wsPath, "package.json")) ||
    existsSync(join(wsPath, ".git")) ||
    existsSync(join(wsPath, "src"))
  )) {
    return false;
  }

  ensureDir(wsPath);
  ensureDir(join(wsPath, "memory"));
  ensureDir(join(wsPath, "tools"));

  writeFileSync(join(wsPath, "AGENTS.md"), agentAgentsMd(agentName, wsPath));

  console.log(`[workspace] provisioned agent workspace: ${wsPath}`);
  return true;
}
