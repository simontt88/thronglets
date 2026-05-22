import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

export interface WorkspaceContext {
  rules: string[];
  agentsMd: string | null;
  structure: string;
  combined: string;
}

function readRulesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".mdc") || entry.name.endsWith(".md")) {
        try {
          const content = readFileSync(fullPath, "utf-8").trim();
          if (content) results.push(content);
        } catch {}
      }
    }
  }

  walk(dir);
  return results;
}

function buildDirectoryTree(root: string, maxDepth = 2): string {
  const lines: string[] = [];
  const IGNORE = new Set([
    "node_modules", ".git", "__pycache__", "dist", ".next",
    ".turbo", "coverage", ".cache", "build",
  ]);

  function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !IGNORE.has(e));
    } catch {
      return;
    }

    entries.sort((a, b) => {
      const aIsDir = statSync(join(dir, a)).isDirectory();
      const bIsDir = statSync(join(dir, b)).isDirectory();
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < entries.length; i++) {
      const name = entries[i];
      const fullPath = join(dir, name);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";

      try {
        if (statSync(fullPath).isDirectory()) {
          lines.push(`${prefix}${connector}${name}/`);
          walk(fullPath, prefix + (isLast ? "    " : "│   "), depth + 1);
        } else {
          lines.push(`${prefix}${connector}${name}`);
        }
      } catch {}
    }
  }

  walk(root, "", 0);
  return lines.join("\n");
}

export function loadWorkspaceContext(workspaceRoot: string): WorkspaceContext {
  const rulesDir = join(workspaceRoot, ".cursor/rules");
  const rules = readRulesRecursive(rulesDir);

  const agentsPath = join(workspaceRoot, "AGENTS.md");
  const agentsMd = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf-8").trim()
    : null;

  const structure = buildDirectoryTree(workspaceRoot);

  const parts: string[] = [];

  if (agentsMd) {
    parts.push(`<agents_md>\n${agentsMd}\n</agents_md>`);
  }

  if (rules.length) {
    parts.push(`<workspace_rules>\n${rules.join("\n\n---\n\n")}\n</workspace_rules>`);
  }

  parts.push(`<directory_structure>\n${structure}\n</directory_structure>`);

  return {
    rules,
    agentsMd,
    structure,
    combined: parts.join("\n\n"),
  };
}
