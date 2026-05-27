// Runtime-level metadata (the underlying agent runtime, not the thronglet).
// Thronglet identity (name, palette, parts) is now derived from agent.name
// via lib/thronglet/generate.ts — runtime no longer owns visual identity.

export const AGENT_COLORS: Record<string, string> = {
  cursor: "#f3c33a",
  "claude-code": "#f0a87a",
  codex: "#9fd97a",
};

export const AGENT_ROLES: Record<string, string> = {
  cursor: "in-IDE edits · refactors · review",
  "claude-code": "terminal · multi-step sweeps · synthesis",
  codex: "automation · planning · long-running jobs",
};

export const PALETTE = ["#f3c33a", "#f0a87a", "#9fd97a", "#a0d4f0", "#b89cd8", "#f0a8c0", "#e8dcb8", "#6a7090"];

export const STATUS_META: Record<string, { color: string; label: string; mood: string }> = {
  working:  { color: "var(--st-working)",  label: "grinding",   mood: "working" },
  waiting:  { color: "var(--st-waiting)",  label: "waiting",    mood: "happy" },
  sleeping: { color: "var(--st-sleeping)", label: "sleeping",   mood: "sleeping" },
  error:    { color: "var(--st-error)",    label: "distressed", mood: "skeptical" },
  stopped:  { color: "var(--st-dead)",     label: "rip",        mood: "dead" },
  dead:     { color: "var(--st-dead)",     label: "dead",       mood: "dead" },
};

export function getAgentColor(runtime: string): string {
  return AGENT_COLORS[runtime] || "#f3c33a";
}

export const RUNTIME_MODELS: Record<string, string[]> = {
  cursor: [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-5.3-codex",
    "claude-4.6-sonnet-medium-thinking",
  ],
  "claude-code": [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
  ],
  codex: [
    "o4-mini",
    "o3",
    "gpt-4.1",
    "o1",
    "o1-mini",
  ],
};

export const RUNTIMES = ["cursor", "claude-code", "codex"] as const;
