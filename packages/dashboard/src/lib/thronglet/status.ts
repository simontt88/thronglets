import type { MoodName } from "./types";

/**
 * Map fleet agent status to a Thronglet mood animation.
 *
 *   working  → "working"   (actively processing)
 *   waiting  → "happy"     (session alive, ready to go)
 *   sleeping → "sleeping"  (session closed, will reconnect)
 *   error    → "skeptical" (something went wrong)
 *   stopped  → "dead"      (agent killed)
 *   dead     → "dead"      (unresponsive)
 */
export function statusToMood(
  status: string,
  _lastActivity?: string,
): MoodName {
  switch (status) {
    case "working":  return "working";
    case "waiting":  return "happy";
    case "sleeping": return "sleeping";
    case "error":    return "skeptical";
    case "stopped":  return "dead";
    case "dead":     return "dead";
    default:         return "idle";
  }
}
