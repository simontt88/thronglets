interface RateBucket {
  timestamps: number[];
}

export class RateLimiter {
  private buckets = new Map<string, RateBucket>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60_000);
  }

  isExceeded(key: string, maxPerHour: number): boolean {
    const now = Date.now();
    const hourAgo = now - 3600_000;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter(t => t > hourAgo);

    if (bucket.timestamps.length >= maxPerHour) {
      return true;
    }

    bucket.timestamps.push(now);
    return false;
  }

  getRemaining(key: string, maxPerHour: number): number {
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const bucket = this.buckets.get(key);
    if (!bucket) return maxPerHour;
    const recent = bucket.timestamps.filter(t => t > hourAgo).length;
    return Math.max(0, maxPerHour - recent);
  }

  private cleanup(): void {
    const hourAgo = Date.now() - 3600_000;
    for (const [key, bucket] of this.buckets) {
      bucket.timestamps = bucket.timestamps.filter(t => t > hourAgo);
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  stop(): void {
    clearInterval(this.cleanupInterval);
  }
}
