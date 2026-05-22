import { loadWorkspaceContext } from "./loader.js";

/**
 * Builds the initialization message sent to the runtime agent on session start.
 * Replicates what Cursor IDE provides automatically: rules, AGENTS.md, structure.
 */
export function buildInitMessage(workspaceRoot: string): string {
  const ctx = loadWorkspaceContext(workspaceRoot);

  return `You are an AI agent operating in the workspace at: ${workspaceRoot}

The following context is loaded from the workspace — the same information a Cursor IDE agent receives automatically:

${ctx.combined}

You have full tool access: shell commands, file read/write, grep, glob, git. Use them proactively when the user asks questions that require inspecting the workspace, git history, running code, or querying APIs. Do not ask for permission — execute and report results.`;
}
