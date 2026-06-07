/**
 * Native agent tools — Phase F.
 *
 * When Thronglets runs the agent loop itself (instead of delegating to a vendor
 * SDK), it must define and execute the tools the model can call. These are the
 * primitives a coding agent needs: read/write/edit files, list directories,
 * search, and run shell commands. Each executor runs locally in the agent's
 * workspace and returns a normalized { ok, content } result.
 */

import { promises as fs, readFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { homedir } from "os";
import { exec } from "child_process";

export interface NativeTool {
  name: string;
  description: string;
  /** JSON-schema-ish parameter spec (object). */
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (input: Record<string, unknown>, cwd: string) => Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

const MAX_OUTPUT = 8000; // cap tool output fed back to the model
const BASH_TIMEOUT_MS = 60_000;

function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Resolve a model-supplied path against the workspace root. */
function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

function runShell(command: string, cwd: string, timeoutMs = BASH_TIMEOUT_MS): Promise<ToolResult> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr ? (stdout ? "\n" : "") + stderr : "");
      const execErr = err as (Error & { killed?: boolean; code?: number }) | null;
      if (execErr && execErr.killed) {
        resolve({ ok: false, content: truncate(out) + `\n[killed: exceeded ${timeoutMs}ms]` });
      } else if (execErr) {
        const code = execErr.code ?? 1;
        resolve({ ok: false, content: truncate(out) + `\n[exit ${code}]` });
      } else {
        resolve({ ok: true, content: truncate(out) || "(no output)" });
      }
    });
  });
}

// ─── VibeSync session history (cloud) ─────────────────────────────────────────
// Lets a throng query the user's past coding sessions — the data lives in the
// vibespace cloud, not the local fs, so these are the only way to reach it.

function vibesyncCreds(): { key: string; base: string } | undefined {
  let key = process.env.VIBESYNC_API_KEY;
  let base = "https://vibespace-five.vercel.app";
  if (!key) {
    try {
      const c = JSON.parse(readFileSync(join(homedir(), ".vibesync", "config.json"), "utf8"));
      key = c.apiKey;
      if (c.backendUrl) base = c.backendUrl;
    } catch { /* no local config */ }
  }
  return key ? { key, base } : undefined;
}

async function vibesyncFetch(path: string, init: RequestInit = {}): Promise<ToolResult> {
  const creds = vibesyncCreds();
  if (!creds) return { ok: false, content: "VibeSync not configured — set VIBESYNC_API_KEY or ~/.vibesync/config.json" };
  try {
    const r = await fetch(creds.base + path, {
      ...init,
      headers: { Authorization: `Bearer ${creds.key}`, "content-type": "application/json", ...(init.headers || {}) },
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, content: `vibesync ${r.status}: ${text.slice(0, 300)}` };
    return { ok: true, content: truncate(text) };
  } catch (e) {
    return { ok: false, content: `vibesync error: ${(e as Error).message}` };
  }
}

const SESSION_TOOLS: NativeTool[] = [
  {
    name: "recall_sessions",
    description: "Search the user's past coding sessions (VibeSync history) by keyword or natural language. Use this for ANY task about past work, search history, or session/token cost analysis — the data is in the cloud, not on disk.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (keywords or natural language)." },
        limit: { type: "string", description: "Max results, 1-50 (default 10)." },
        workspace_id: { type: "string", description: "Optional workspace filter (slug, from list_session_workspaces)." },
      },
      required: ["query"],
    },
    async run(input) {
      const body: Record<string, unknown> = { query: String(input.query || ""), limit: Number(input.limit || 10) };
      if (input.workspace_id) body.workspace_id = String(input.workspace_id);
      return vibesyncFetch("/api/sync/recall", { method: "POST", body: JSON.stringify(body) });
    },
  },
  {
    name: "list_session_workspaces",
    description: "List the user's VibeSync workspaces with session/event counts. Use to pick which workspace to analyze.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      return vibesyncFetch("/api/sync/workspaces");
    },
  },
  {
    name: "get_session",
    description: "Fetch a past session's events (ordered, paginated) by id — reconstruct a task's full flow, including the search/exploration phase.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id (from recall_sessions results)." },
        page: { type: "string", description: "Page number, default 0 (100 events/page)." },
      },
      required: ["session_id"],
    },
    async run(input) {
      const id = encodeURIComponent(String(input.session_id || ""));
      return vibesyncFetch(`/api/sync/sessions/${id}?limit=100&page=${Number(input.page || 0)}`);
    },
  },
];

export const NATIVE_TOOLS: NativeTool[] = [
  {
    name: "read_file",
    description: "Read the full contents of a file in the workspace. Returns the text with 1-based line numbers.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path, absolute or relative to the workspace." } },
      required: ["path"],
    },
    async run(input, cwd) {
      const p = resolvePath(String(input.path || ""), cwd);
      try {
        const text = await fs.readFile(p, "utf8");
        const numbered = text
          .split("\n")
          .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
          .join("\n");
        return { ok: true, content: truncate(numbered) };
      } catch (e) {
        return { ok: false, content: `read_file failed: ${(e as Error).message}` };
      }
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Creates parent directories as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the workspace." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
    async run(input, cwd) {
      const p = resolvePath(String(input.path || ""), cwd);
      try {
        await fs.mkdir(dirname(p), { recursive: true });
        await fs.writeFile(p, String(input.content ?? ""), "utf8");
        return { ok: true, content: `wrote ${String(input.content ?? "").length} bytes to ${input.path}` };
      } catch (e) {
        return { ok: false, content: `write_file failed: ${(e as Error).message}` };
      }
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact substring in a file. old_string must appear exactly once. Use for surgical edits.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the workspace." },
        old_string: { type: "string", description: "Exact text to replace (must be unique in the file)." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(input, cwd) {
      const p = resolvePath(String(input.path || ""), cwd);
      const oldStr = String(input.old_string ?? "");
      const newStr = String(input.new_string ?? "");
      try {
        const text = await fs.readFile(p, "utf8");
        const count = oldStr ? text.split(oldStr).length - 1 : 0;
        if (count === 0) return { ok: false, content: `edit_file failed: old_string not found in ${input.path}` };
        if (count > 1) return { ok: false, content: `edit_file failed: old_string appears ${count}× — make it unique` };
        await fs.writeFile(p, text.replace(oldStr, newStr), "utf8");
        return { ok: true, content: `edited ${input.path}` };
      } catch (e) {
        return { ok: false, content: `edit_file failed: ${(e as Error).message}` };
      }
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory. Directories are suffixed with '/'.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: workspace root)." } },
      required: [],
    },
    async run(input, cwd) {
      const p = resolvePath(String(input.path || "."), cwd);
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        const lines = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
        return { ok: true, content: truncate(lines) || "(empty)" };
      } catch (e) {
        return { ok: false, content: `list_dir failed: ${(e as Error).message}` };
      }
    },
  },
  {
    name: "grep",
    description: "Search the workspace for a regex pattern. Returns matching file:line:text rows.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex to search for." },
        path: { type: "string", description: "Directory or file to search (default: workspace root)." },
      },
      required: ["pattern"],
    },
    async run(input, cwd) {
      const pattern = String(input.pattern || "");
      const target = String(input.path || ".");
      // Prefer ripgrep, fall back to grep -rIn. Pattern is passed as a single argument.
      const q = pattern.replace(/'/g, "'\\''");
      const t = target.replace(/'/g, "'\\''");
      const cmd = `command -v rg >/dev/null 2>&1 && rg -n --no-heading -e '${q}' '${t}' || grep -rInE -- '${q}' '${t}'`;
      const res = await runShell(cmd, cwd, 20_000);
      // grep/rg exit 1 on "no matches" — that's not an error for us.
      if (!res.ok && /no output|\[exit 1\]/.test(res.content)) {
        return { ok: true, content: res.content.replace(/\n?\[exit 1\]/, "") || "(no matches)" };
      }
      return res;
    },
  },
  {
    name: "run_bash",
    description: "Run a shell command in the workspace and return combined stdout/stderr. Use for builds, tests, git, etc.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command to execute." } },
      required: ["command"],
    },
    async run(input, cwd) {
      return runShell(String(input.command || ""), cwd);
    },
  },
];

// Session-history tools are appended so every native throng can reach past work.
NATIVE_TOOLS.push(...SESSION_TOOLS);

export const TOOLS_BY_NAME: Record<string, NativeTool> = Object.fromEntries(
  NATIVE_TOOLS.map((t) => [t.name, t]),
);

/** Short human-readable summary of a tool call for the activity feed. */
export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `📖 ${input.path || "?"}`;
    case "write_file":
      return `✏️ ${input.path || "?"}`;
    case "edit_file":
      return `✂️ ${input.path || "?"}`;
    case "list_dir":
      return `📁 ${input.path || "."}`;
    case "grep":
      return `🔍 ${input.pattern || "?"}`;
    case "run_bash":
      return `▶️ ${String(input.command || "").split("\n")[0].slice(0, 60)}`;
    case "recall_sessions":
      return `🔎 recall: ${input.query || "?"}`;
    case "list_session_workspaces":
      return `🗂 workspaces`;
    case "get_session":
      return `📜 ${String(input.session_id || "?").slice(0, 12)}`;
    default:
      return `🔧 ${name}`;
  }
}
