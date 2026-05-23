import type { MoodName } from "./types";

const IDLE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Map fleet agent state to a Thronglet mood.
 *
 * Rules:
 *   working  → "working"        (actively processing)
 *   error    → "skeptical"      (something went wrong)
 *   stopped  → "dead"           (agent crashed or was killed)
 *   dead     → "dead"
 *   idle     → depends on how long idle:
 *              < 20 min:  "happy"    (just finished, still warm)
 *              ≥ 20 min:  "sleeping" (dozed off)
 */
export function statusToMood(
  status: string,
  lastActivity?: string,
): MoodName {
  switch (status) {
    case "working": return "working";
    case "error":   return "skeptical";
    case "stopped": return "dead";
    case "dead":    return "dead";
    case "idle": {
      if (!lastActivity) return "idle";
      const elapsed = Date.now() - new Date(lastActivity).getTime();
      if (elapsed < IDLE_THRESHOLD_MS) return "happy";
      return "sleeping";
    }
    default: return "idle";
  }
}
