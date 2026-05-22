// Context injection is NOT needed for Cursor SDK runtime.
// When using local: { cwd }, the SDK automatically reads:
//   - {cwd}/.cursor/rules/**/*.mdc
//   - {cwd}/AGENTS.md
//
// This is identical to opening Cursor IDE on that directory.
//
// This file is kept as a placeholder for runtimes that DON'T
// have native workspace awareness (e.g. raw LLM API calls).

import { loadWorkspaceContext } from "./loader.js";

export function buildInitMessage(workspaceRoot: string): string {
  const ctx = loadWorkspaceContext(workspaceRoot);
  return `Workspace: ${workspaceRoot}\n\n${ctx.combined}`;
}
