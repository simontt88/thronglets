export type NotifLevel = "critical" | "info" | "debug";

interface ThrottleEntry {
  lastSentAt: number;
  count: number;
  firstOccurrence: number;
  lastMessage: string;
}

export class NotificationThrottle {
  private entries: Map<string, ThrottleEntry> = new Map();
  private cooldownMs: number;

  constructor(cooldownMs = 30 * 60 * 1000) {
    this.cooldownMs = cooldownMs;
  }

  shouldSend(category: string, level: NotifLevel, message: string): boolean {
    if (level === "debug") return false;
    if (level === "critical") {
      this.reset(category);
      return true;
    }

    const now = Date.now();
    const entry = this.entries.get(category);

    if (!entry) {
      this.entries.set(category, {
        lastSentAt: now,
        count: 1,
        firstOccurrence: now,
        lastMessage: message,
      });
      return true;
    }

    entry.count++;
    entry.lastMessage = message;

    if (now - entry.lastSentAt >= this.cooldownMs) {
      entry.lastSentAt = now;
      return true;
    }

    return false;
  }

  getBatchSummary(category: string): string | null {
    const entry = this.entries.get(category);
    if (!entry || entry.count <= 1) return null;

    const elapsed = Date.now() - entry.firstOccurrence;
    const elapsedStr = elapsed < 3600_000
      ? `${Math.round(elapsed / 60_000)}min`
      : `${(elapsed / 3600_000).toFixed(1)}h`;

    return `${category}: ${entry.count}x in ${elapsedStr}`;
  }

  getCount(category: string): number {
    return this.entries.get(category)?.count ?? 0;
  }

  reset(category: string): void {
    this.entries.delete(category);
  }

  resetAll(): void {
    this.entries.clear();
  }
}
