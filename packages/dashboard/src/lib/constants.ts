export const AGENT_COLORS: Record<string, string> = {
  cursor: "#5e93c4",
  "claude-code": "#b07f6a",
  codex: "#6aaa83",
};

export const AGENT_GLYPHS: Record<string, string> = {
  cursor: "Cu",
  "claude-code": "CC",
  codex: "Cx",
};

export const AGENT_ROLES: Record<string, string> = {
  cursor: "in-IDE edits · refactors · review",
  "claude-code": "terminal · multi-step sweeps · synthesis",
  codex: "automation · planning · long-running jobs",
};

export const PALETTE = ["#5e93c4", "#b07f6a", "#6aaa83", "#c89a55", "#c47a8e", "#8a82b8", "#6fb3ba", "#7a8392"];

export const STATUS_META: Record<string, { color: string; label: string }> = {
  working: { color: "var(--st-working)", label: "working" },
  idle: { color: "var(--st-idle)", label: "idle" },
  error: { color: "var(--st-error)", label: "error" },
  stopped: { color: "var(--st-idle)", label: "stopped" },
};

export function getAgentColor(runtime: string): string {
  return AGENT_COLORS[runtime] || "#8b8e9a";
}

export function getAgentGlyph(runtime: string): string {
  return AGENT_GLYPHS[runtime] || "??";
}
