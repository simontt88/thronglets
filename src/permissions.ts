// Permissions are now handled at the agent config level.
// Each runtime reads permission settings from its own AgentDef config.
// This file is kept for potential future unified permission mapping.

export type PermissionMode = "readonly" | "safe" | "full" | "custom";
